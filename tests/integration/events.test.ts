import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { BASE_URL, signUp, signIn } from "../setup";

// Live change events (SSE) and the webhooks fed from the same change stream.
// The test server runs with WREN_WEBHOOK_ALLOW_HOSTS=localhost and a short
// WEBHOOK_BATCH_WINDOW_MS so the in-test webhook receiver gets batches quickly.
const stamp = Date.now();
let cookie: string, key: string, slug: string;
const H = () => ({ Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json" });
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE_URL}${path}`, { method, headers: H(), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

type Ev = { type: string; _id?: string; [k: string]: any };
async function stream(path: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "text/event-stream", ...headers }, signal: ctrl.signal });
  const events: Ev[] = [];
  if (res.ok) (async () => {
    const reader = res.body!.getReader(), dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const lines = block.split("\n");
          const data = lines.filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
          const id = lines.find(l => l.startsWith("id: "))?.slice(4);
          if (data) events.push({ ...JSON.parse(data), _id: id });
        }
      }
    } catch {}
  })();
  const waitFor = async (pred: (e: Ev) => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await Bun.sleep(25); }
    return undefined;
  };
  if (res.ok) await waitFor(e => e.type === "ready");
  return { res, events, waitFor, close: () => ctrl.abort() };
}

// Webhook receiver in the test process (the server runs in the same container)
const received: any[] = [];
let sink: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const email = `events${stamp}@wren.dev`;
  await signUp(email, "secret123", "Events");
  cookie = (await signIn(email, "secret123")).cookie;
  slug = (await api("GET", "/api/v1/me")).json.org.slug;
  key = (await api("POST", "/api/v1/keys", { name: "events" })).json.key;
  sink = Bun.serve({ port: 4123, async fetch(req) { received.push(await req.json()); return new Response("ok"); } });
});
afterAll(() => sink?.stop(true));

describe("event streams", () => {
  it("private stream: create, update, label, delete with ids and versions (API key)", async () => {
    const col = `ev${stamp}`;
    const s = await stream(`/api/v1/_events?collections=${col}`, { Authorization: `Bearer ${key}` });
    expect(s.res.headers.get("content-type")).toStartWith("text/event-stream");
    const id = (await api("POST", `/api/v1/${col}`, { n: 1 })).json.id;
    await api("PUT", `/api/v1/${col}/${id}`, { n: 2 });
    await api("POST", `/api/v1/${col}/${id}/labels`, { label: "published" });
    await api("DELETE", `/api/v1/${col}/${id}`);
    expect(await s.waitFor(e => e.type === "document.created" && e.id === id && e.version === 1 && e.collection === col)).toBeTruthy();
    expect(await s.waitFor(e => e.type === "document.updated" && e.id === id && e.version === 2)).toBeTruthy();
    expect(await s.waitFor(e => e.type === "label.set" && e.id === id && e.label === "published" && e.version === 2)).toBeTruthy();
    expect(await s.waitFor(e => e.type === "document.deleted" && e.id === id)).toBeTruthy();
    expect(s.events.find(e => e.type === "document.created")!._id).toMatch(/^[a-z0-9]+-\d+$/);
    s.close();
  });

  it("the collections filter keeps other collections out", async () => {
    const s = await stream(`/api/v1/_events?collections=only${stamp}`, { Cookie: cookie });
    await api("POST", `/api/v1/other${stamp}`, { x: 1 });
    await api("POST", `/api/v1/only${stamp}`, { x: 1 });
    expect(await s.waitFor(e => e.collection === `only${stamp}`)).toBeTruthy();
    expect(s.events.some(e => e.collection === `other${stamp}`)).toBe(false);
    s.close();
  });

  it("needs a key or session", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/_events`)).status).toBe(401);
  });

  it("public stream: only the published label, only public collections, no drafts", async () => {
    const pub = `pub${stamp}`, priv = `priv${stamp}`;
    await api("POST", "/api/v1/permissions", { principal: "*", resource: `collection:${pub}`, access: "read", labelFilter: "published" });
    const s = await stream(`/api/v1/orgs/${slug}/_events`);
    expect(s.res.headers.get("access-control-allow-origin")).toBe("*");
    const id = (await api("POST", `/api/v1/${pub}`, { draft: true })).json.id;
    await api("POST", `/api/v1/${pub}/${id}/labels`, { label: "preview" });
    await api("POST", `/api/v1/${priv}`, { secret: true });
    await api("POST", `/api/v1/${pub}/${id}/labels`, { label: "published" });
    expect(await s.waitFor(e => e.type === "label.set" && e.id === id && e.label === "published")).toBeTruthy();
    await Bun.sleep(200);
    expect(s.events.filter(e => !["ready"].includes(e.type)).map(e => `${e.type}:${e.label ?? ""}:${e.collection}`))
      .toEqual([`label.set:published:${pub}`]);
    s.close();
  });

  it("public stream on the clean URL, for trees: a published page reports where it lives", async () => {
    const tree = `site${stamp}`, col = `pages${stamp}`;
    await api("POST", "/api/v1/permissions", { principal: "*", resource: `tree:${tree}`, access: "read", labelFilter: "published" });
    const s = await stream(`/orgs/${slug}/_events?trees=${tree}`);
    const id = (await api("POST", `/api/v1/${col}`, { title: "Home" })).json.id;
    await api("PUT", `/api/v1/tree/${tree}/index.html`, { documentId: id });
    await api("POST", `/api/v1/${col}/${id}/labels`, { label: "published" });
    const e = await s.waitFor(e => e.type === "label.set" && e.id === id);
    expect(e?.trees).toEqual([{ tree, path: "/index.html" }]);
    expect(s.events.some(e => e.type === "tree.assigned")).toBe(false); // could point at an unreleased page
    s.close();
  });

  it("an unknown org is a 404", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/orgs/no-such-org-${stamp}/_events`)).status).toBe(404);
  });

  it("resumes after a reconnect with Last-Event-ID, and says reset when it can't", async () => {
    const col = `res${stamp}`;
    const a = await stream(`/api/v1/_events?collections=${col}`, { Cookie: cookie });
    await api("POST", `/api/v1/${col}`, { n: 1 });
    const first = await a.waitFor(e => e.type === "document.created");
    a.close();
    const missed = (await api("POST", `/api/v1/${col}`, { n: 2 })).json.id;
    await Bun.sleep(300);
    const b = await stream(`/api/v1/_events?collections=${col}`, { Cookie: cookie, "Last-Event-ID": first!._id! });
    expect(await b.waitFor(e => e.type === "document.created" && e.id === missed)).toBeTruthy();
    b.close();
    const c = await stream(`/api/v1/_events?collections=${col}`, { Cookie: cookie, "Last-Event-ID": "old-1" });
    expect(c.events.some(e => e.type === "reset")).toBe(true);
    c.close();
  });
});

describe("webhooks", () => {
  it("refuses private, local and non-http targets", async () => {
    for (const url of ["http://127.0.0.1:4000/x", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://[::1]/", "ftp://example.com/x"]) {
      const r = await api("POST", "/api/v1/webhooks", { url });
      expect(r.status).toBe(400);
    }
  });

  it("deliver complete events from every write path: ids, versions, labels, keys", async () => {
    const wh = await api("POST", "/api/v1/webhooks", { url: "http://localhost:4123/hook" });
    expect(wh.status).toBe(201);
    const col = `hook${stamp}`;
    const id = (await api("POST", `/api/v1/${col}`, { n: 1 })).json.id;
    await api("POST", `/api/v1/${col}/${id}/labels`, { label: "published" });
    const t0 = Date.now();
    const all = () => received.flatMap(b => b.events);
    while (Date.now() - t0 < 8000 && !all().some((e: any) => e.type === "label.set" && e.payload.id === id)) await Bun.sleep(100);
    const created = all().find((e: any) => e.type === "document.created" && e.payload.id === id);
    expect(created?.payload).toMatchObject({ collection: col, id, version: 1 });
    expect(all().find((e: any) => e.type === "label.set" && e.payload.id === id)?.payload).toMatchObject({ label: "published", version: 1 });
  });
});
