import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { call, account, invite, useOrg, newKey, until, type Account } from "./access-helpers";

// Webhook management: target URL rules, CRUD, signed deliveries and their log,
// event filters, replay, and auto-disable after repeated failures. The test server
// allows http://localhost receivers (WREN_WEBHOOK_ALLOW_HOSTS=localhost) and batches
// every 500 ms (WEBHOOK_BATCH_WINDOW_MS).
const stamp = Date.now();
const tag = `wh${stamp}`;
const PORT = 4124;
let owner: Account, admin: Account, member: Account;

type Hit = { path: string; body: string; json: any; signature: string | null; delivery: string | null };
const hits: Hit[] = [];
let sink: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // /ok/... answers 200, /fail/... answers 500
  sink = Bun.serve({
    port: PORT,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      hits.push({ path, body, json: JSON.parse(body), signature: req.headers.get("x-wren-signature"), delivery: req.headers.get("x-wren-delivery") });
      return new Response(path.startsWith("/fail") ? "nope" : "ok", { status: path.startsWith("/fail") ? 500 : 200 });
    },
  });
  owner = await account("owner", tag);
  admin = await account("admin", tag);
  member = await account("member", tag);
  await invite(owner, admin, "admin", []);
  await invite(owner, member, "member", []);
  await useOrg(admin, owner.id);
  await useOrg(member, owner.id);
});
afterAll(() => sink?.stop(true));

const hook = (who: { cookie: string }, body: Record<string, unknown>) => call("POST", "/api/v1/webhooks", { cookie: who.cookie, body });
const url = (path: string) => `http://localhost:${PORT}${path}`;
const eventsAt = (path: string) => hits.filter(h => h.path === path).flatMap(h => h.json.events);

async function hmac(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
}

describe("target URLs", () => {
  it("must be present, valid, http(s) and public", async () => {
    expect((await hook(owner, {})).json.error).toBe("url is required");
    expect((await hook(owner, { url: "not a url" })).json.error).toBe("Invalid URL");
    expect((await hook(owner, { url: "file:///etc/passwd" })).status).toBe(400);
    const privateTargets = [
      "http://192.168.1.10/hook", "http://172.16.0.1/", "http://172.31.255.1/", "http://100.64.0.1/", "http://0.0.0.0/",
      "http://224.0.0.1/", "http://198.18.0.1/", "http://[fd00::1]/", "http://[fe80::1]/",
      "http://[::]/", "https://169.254.169.254/latest/meta-data/",
    ];
    for (const u of privateTargets) {
      const r = await hook(owner, { url: u });
      expect(r.status).toBe(400);
      expect(r.json.error).toContain("private or local");
    }
    const unresolvable = await hook(owner, { url: `https://no-such-host-${stamp}.invalid/hook` });
    expect(unresolvable.status).toBe(400);
    expect(unresolvable.json.error).toContain("does not resolve");
  });

  it("fixed: IPv4-mapped IPv6 addresses bypass the private-address check", async () => {
    // new URL() normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1]; isPrivateAddress only
    // understands the dotted ::ffff:a.b.c.d form, so loopback and the cloud metadata
    // address are accepted, and deliveries are then sent there (SSRF).
    for (const u of ["http://[::ffff:127.0.0.1]:4000/api/v1/me", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[::ffff:a00:1]/"]) {
      const r = await hook(owner, { url: u });
      if (r.status === 201) await call("DELETE", `/api/v1/webhooks/${r.json.id}`, { cookie: owner.cookie });
      expect(r.status).toBe(400);
    }
  });

  it("a public address is accepted", async () => {
    const r = await hook(owner, { url: "https://93.184.215.14/hook" });
    expect(r.status).toBe(201);
    await call("DELETE", `/api/v1/webhooks/${r.json.id}`, { cookie: owner.cookie });
  });
});

describe("managing webhooks", () => {
  let id: string;

  it("create returns the signing secret once; the list never shows it", async () => {
    const r = await hook(owner, { url: url("/ok/crud"), events: ["document.created", 7, "label.set"] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ url: url("/ok/crud"), events: ["document.created", "label.set"], enabled: true, consecFailures: 0 });
    expect(r.json.secret).toMatch(/^[0-9a-f]{64}$/);
    id = r.json.id;
    const list = (await call("GET", "/api/v1/webhooks", { cookie: owner.cookie })).json.webhooks;
    const listed = list.find((w: any) => w.id === id);
    expect(listed).toMatchObject({ url: url("/ok/crud"), enabled: true, events: ["document.created", "label.set"] });
    expect(listed.secret).toBeUndefined();
  });

  it("update: url (re-checked), events and enabled", async () => {
    expect((await call("PUT", `/api/v1/webhooks/${id}`, { cookie: owner.cookie, body: { url: "http://10.1.2.3/" } })).status).toBe(400);
    const r = await call("PUT", `/api/v1/webhooks/${id}`, { cookie: owner.cookie, body: { url: url("/ok/crud2"), events: [], enabled: false } });
    expect(r.json).toEqual({ id, updated: true });
    const listed = (await call("GET", "/api/v1/webhooks", { cookie: owner.cookie })).json.webhooks.find((w: any) => w.id === id);
    expect(listed).toMatchObject({ url: url("/ok/crud2"), events: [], enabled: false });
    expect((await call("PUT", "/api/v1/webhooks/nope", { cookie: owner.cookie, body: { enabled: true } })).status).toBe(404);
  });

  it("delete; afterwards the webhook and its log are gone", async () => {
    expect((await call("DELETE", `/api/v1/webhooks/${id}`, { cookie: owner.cookie })).json).toEqual({ id, deleted: true });
    expect((await call("DELETE", `/api/v1/webhooks/${id}`, { cookie: owner.cookie })).status).toBe(404);
    expect((await call("GET", `/api/v1/webhooks/${id}/deliveries`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("admins (and their keys) manage webhooks; members can't", async () => {
    const r = await hook(admin, { url: url("/ok/admin") });
    expect(r.status).toBe(201);
    const k = await newKey(admin.cookie, "hooks");
    expect((await call("GET", "/api/v1/webhooks", { key: k.key })).json.webhooks.some((w: any) => w.id === r.json.id)).toBe(true);
    expect((await hook(member, { url: url("/ok/member") })).status).toBe(403);
    expect((await call("GET", "/api/v1/webhooks", { cookie: member.cookie })).status).toBe(403);
    expect((await call("PUT", `/api/v1/webhooks/${r.json.id}`, { cookie: member.cookie, body: { enabled: false } })).status).toBe(403);
    expect((await call("DELETE", `/api/v1/webhooks/${r.json.id}`, { cookie: member.cookie })).status).toBe(403);
    expect((await call("GET", `/api/v1/webhooks/${r.json.id}/deliveries`, { cookie: member.cookie })).status).toBe(403);
    expect((await call("POST", `/api/v1/webhooks/${r.json.id}/replay`, { cookie: member.cookie, body: {} })).status).toBe(403);
    await call("DELETE", `/api/v1/webhooks/${r.json.id}`, { cookie: owner.cookie });
  });

  it("another org's webhooks are invisible", async () => {
    const other = await account("other", tag);
    const theirs = await hook(other, { url: url("/ok/theirs") });
    for (const [method, path] of [["PUT", ""], ["DELETE", ""], ["GET", "/deliveries"], ["POST", "/replay"]] as const) {
      const r = await call(method, `/api/v1/webhooks/${theirs.json.id}${path}`, { cookie: owner.cookie, body: method === "DELETE" || method === "GET" ? undefined : { since: "2020-01-01" } });
      expect(r.status).toBe(404);
    }
    await call("DELETE", `/api/v1/webhooks/${theirs.json.id}`, { cookie: other.cookie });
  });

  it("at most 10 per org", async () => {
    const busy = await account("busy", tag);
    for (let i = 0; i < 10; i++) expect((await hook(busy, { url: url(`/ok/many${i}`), events: ["none.such"] })).status).toBe(201);
    const r = await hook(busy, { url: url("/ok/eleven") });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("Maximum 10");
  });

  it("unrouted methods are 405", async () => {
    expect((await call("PUT", "/api/v1/webhooks", { cookie: owner.cookie, body: {} })).status).toBe(405);
    expect((await call("GET", "/api/v1/webhooks/x/other", { cookie: owner.cookie })).status).toBe(405);
  });
});

describe("deliveries", () => {
  let all: { id: string; secret: string }, labels: { id: string };
  const col = `whd${stamp}`;
  let docId: string;

  beforeAll(async () => {
    const a = await hook(owner, { url: url("/ok/all") });
    all = { id: a.json.id, secret: a.json.secret };
    labels = (await hook(owner, { url: url("/ok/labels"), events: ["label.set"] })).json;
    docId = (await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { n: 1 } })).json.id;
    await call("POST", `/api/v1/${col}/${docId}/labels`, { cookie: owner.cookie, body: { label: "published" } });
  });

  it("are signed with the webhook's secret", async () => {
    const hit = await until(() => hits.find(h => h.path === "/ok/all" && h.json.events.some((e: any) => e.payload?.id === docId)), 10000);
    expect(hit).toBeTruthy();
    expect(hit!.signature).toBe(await hmac(hit!.body, all.secret));
    expect(hit!.delivery).toBe(hit!.json.batchKey);
    expect(hit!.json.deliveredAt).toBeTruthy();
  }, 20000);

  it("only carry the subscribed event types", async () => {
    await until(() => eventsAt("/ok/labels").some((e: any) => e.payload?.id === docId), 10000);
    const types = new Set(eventsAt("/ok/labels").map((e: any) => e.type));
    expect([...types]).toEqual(["label.set"]);
    await until(() => eventsAt("/ok/all").some((e: any) => e.type === "label.set" && e.payload?.id === docId), 10000);
    expect(eventsAt("/ok/all").map((e: any) => e.type)).toEqual(expect.arrayContaining(["document.created", "label.set"]));
  }, 20000);

  it("are logged per webhook with status and event count", async () => {
    const log = await until(async () => {
      const d = (await call("GET", `/api/v1/webhooks/${all.id}/deliveries`, { cookie: owner.cookie })).json.deliveries;
      return d.length ? d : null;
    }, 5000);
    expect(log[0]).toMatchObject({ statusCode: 200, attempt: 1, error: null });
    expect(log[0].eventCount).toBeGreaterThan(0);
    expect(log[0].batchKey).toContain(owner.id);
  }, 20000);

  it("a disabled webhook gets nothing", async () => {
    await call("PUT", `/api/v1/webhooks/${labels.id}`, { cookie: owner.cookie, body: { enabled: false } });
    const before = eventsAt("/ok/labels").length;
    const id = (await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { n: 2 } })).json.id;
    await call("POST", `/api/v1/${col}/${id}/labels`, { cookie: owner.cookie, body: { label: "published" } });
    await until(() => eventsAt("/ok/all").some((e: any) => e.type === "label.set" && e.payload?.id === id), 10000);
    expect(eventsAt("/ok/labels").length).toBe(before);
  }, 20000);

  it("replay: needs a start date; an empty range replays nothing", async () => {
    expect((await call("POST", `/api/v1/webhooks/${all.id}/replay`, { cookie: owner.cookie, body: {} })).status).toBe(400);
    const none = await call("POST", `/api/v1/webhooks/${all.id}/replay`, { cookie: owner.cookie, body: { since: "2001-01-01", until: "2001-01-02" } });
    expect(none.json).toEqual({ replayed: 0 });
    const r = await call("POST", `/api/v1/webhooks/${all.id}/replay`, { cookie: owner.cookie, body: { since: new Date(Date.now() - 3600_000).toISOString() } });
    expect(r.json.replayed).toBeGreaterThan(0);
    expect(r.json.batchKey).toStartWith(`${owner.id}:replay:`);
  });

  it("fixed: replayed events are never delivered", async () => {
    // The replay batch key ends in a millisecond timestamp, while the batch processor
    // reads the last key segment as a window number (× WEBHOOK_BATCH_WINDOW_MS), so the
    // replay batch never becomes "ready" and stays in memory forever.
    const r = await call("POST", `/api/v1/webhooks/${all.id}/replay`, { cookie: owner.cookie, body: { since: new Date(Date.now() - 3600_000).toISOString() } });
    const got = await until(() => hits.some(h => h.json.batchKey === r.json.batchKey), 5000);
    expect(got).toBe(true);
  }, 20000);
});

describe("failures", () => {
  it("are retried, logged, and disable the webhook after 10 failed batches", async () => {
    // A separate org, so its only webhook is the failing one
    const flaky = await account("flaky", tag);
    const wh = (await hook(flaky, { url: url("/fail/always") })).json;
    const col = `fail${stamp}`;
    // 11 writes in separate 500 ms batch windows → 11 batches, each tried 5 times
    for (let i = 0; i < 11; i++) {
      await call("POST", `/api/v1/${col}`, { cookie: flaky.cookie, body: { i } });
      await Bun.sleep(550);
    }
    const disabled = await until(async () => {
      const w = (await call("GET", "/api/v1/webhooks", { cookie: flaky.cookie })).json.webhooks[0];
      return w.enabled === false ? w : null;
    }, 45000, 500);
    expect(disabled).toBeTruthy();
    expect(disabled.consecFailures).toBeGreaterThanOrEqual(10);
    const log = (await call("GET", `/api/v1/webhooks/${wh.id}/deliveries`, { cookie: flaky.cookie })).json.deliveries;
    expect(log.every((d: any) => d.statusCode === 500)).toBe(true);
    expect(new Set(log.map((d: any) => d.attempt))).toEqual(new Set([1, 2, 3, 4, 5]));

    // re-enabling resets the failure count
    await call("PUT", `/api/v1/webhooks/${wh.id}`, { cookie: flaky.cookie, body: { enabled: true, url: url("/ok/recovered") } });
    const back = (await call("GET", "/api/v1/webhooks", { cookie: flaky.cookie })).json.webhooks[0];
    expect(back).toMatchObject({ enabled: true, consecFailures: 0 });
  }, 90000);
});
