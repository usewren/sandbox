import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, invite, useOrg, groupIds, newKey, rule, type Account } from "./access-helpers";

// Regression tests for the public-route security fixes (CHANGELOG 0.5.0, 0.6.0,
// Unreleased): read-only public URLs, label filters, caching, CORS, key org scoping.
const stamp = Date.now();
const tag = `sec${stamp}`;
const foreign = "https://evil.example";
let owner: Account, member: Account, outsider: Account;
const pub = `spub${stamp}`, priv = `spriv${stamp}`;
let pubId: string, privId: string;

beforeAll(async () => {
  owner = await account("owner", tag);
  member = await account("member", tag);
  outsider = await account("outsider", tag);
  pubId = (await call("POST", `/api/v1/${pub}`, { cookie: owner.cookie, body: { title: "pub-v1", slug: "first" } })).json.id;
  await call("POST", `/api/v1/${pub}/${pubId}/labels`, { cookie: owner.cookie, body: { label: "published" } });
  await call("PUT", `/api/v1/${pub}/${pubId}`, { cookie: owner.cookie, body: { title: "pub-v2-draft", slug: "first" } });
  privId = (await call("POST", `/api/v1/${priv}`, { cookie: owner.cookie, body: { title: "top-secret-salary" } })).json.id;
  await call("POST", `/api/v1/${priv}/${privId}/labels`, { cookie: owner.cookie, body: { label: "published" } });
  await rule(owner.cookie, { principal: "*", resource: `collection:${pub}`, access: "read", labelFilter: "published" });
});

describe("public URLs are read-only", () => {
  it("writes to /api/v1/orgs/... are 405", async () => {
    for (const [method, path] of [
      ["PUT", `/api/v1/orgs/${owner.slug}/${pub}/${pubId}`],
      ["DELETE", `/api/v1/orgs/${owner.slug}/${pub}/${pubId}`],
      ["POST", `/api/v1/orgs/${owner.slug}/${pub}/${pubId}`],
      ["POST", `/api/v1/orgs/${owner.slug}/tree/site/index.html`],
      ["PUT", `/api/v1/orgs/${owner.slug}/tree/site/index.html`],
    ] as const) {
      const r = await call(method, path, { body: { x: 1 } });
      expect(r.status).toBe(405);
    }
  });

  it("the clean /orgs/ URLs only answer GET", async () => {
    expect((await call("POST", `/orgs/${owner.slug}/${pub}`, { body: {} })).status).toBe(404);
    expect((await call("DELETE", `/orgs/${owner.slug}/${pub}/${pubId}`)).status).toBe(404);
  });

  it("an API key doesn't turn a public URL into a write or widen it", async () => {
    const k = await newKey(owner.cookie, "pub");
    expect((await call("POST", `/api/v1/orgs/${owner.slug}/${pub}/${pubId}`, { key: k.key, body: {} })).status).toBe(405);
    // credentials are ignored on public routes: the private collection stays closed
    expect((await call("GET", `/api/v1/orgs/${owner.slug}/${priv}`, { key: k.key })).status).toBe(403);
    expect((await call("GET", `/api/v1/orgs/${owner.slug}/${priv}/${privId}`, { cookie: owner.cookie })).status).toBe(403);
  });
});

describe("public reads follow the rule", () => {
  it("no rule, no access; unknown orgs and bare org URLs are 404", async () => {
    expect((await call("GET", `/api/v1/orgs/${owner.slug}/${priv}`)).status).toBe(403);
    expect((await call("GET", `/api/v1/orgs/no-such-org-${stamp}/${pub}`)).status).toBe(404);
    expect((await call("GET", `/api/v1/orgs/${owner.slug}`)).status).toBe(404);
    expect((await call("GET", `/orgs/${owner.slug}`)).status).toBe(404);
  });

  it("?label= can't override the rule's label filter on single documents", async () => {
    for (const q of ["", "?label=", "?label=draft"]) {
      const r = await call("GET", `/api/v1/orgs/${owner.slug}/${pub}/${pubId}${q}`);
      expect(r.json.data.title).toBe("pub-v1");
    }
  });

  it("_query can't override the label filter either", async () => {
    const r = await call("POST", `/api/v1/orgs/${owner.slug}/${pub}/_query`, { body: { label: "latest" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("pub-v2-draft");
  });

  it("by-key reads use the labelled version", async () => {
    const keyed = `keyed${stamp}`;
    await call("PUT", `/api/v1/${keyed}/_schema`, { cookie: owner.cookie, body: { naturalKey: "slug", schema: { type: "object" } } });
    const id = (await call("POST", `/api/v1/${keyed}`, { cookie: owner.cookie, body: { slug: "first", title: "keyed-v1" } })).json.id;
    await call("POST", `/api/v1/${keyed}/${id}/labels`, { cookie: owner.cookie, body: { label: "published" } });
    await call("PUT", `/api/v1/${keyed}/${id}`, { cookie: owner.cookie, body: { slug: "first", title: "keyed-v2-draft" } });
    await rule(owner.cookie, { principal: "*", resource: `collection:${keyed}`, access: "read", labelFilter: "published" });
    const r = await call("GET", `/api/v1/orgs/${owner.slug}/${keyed}/by-key/first?label=draft`);
    expect(r.status).toBe(200);
    expect(r.json.data.title).toBe("keyed-v1");
  });

  it("public responses are shared-cacheable; their errors are not", async () => {
    const ok = await call("GET", `/api/v1/orgs/${owner.slug}/${pub}`);
    expect(ok.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=86400");
    const denied = await call("GET", `/api/v1/orgs/${owner.slug}/${priv}`);
    expect(denied.status).toBe(403);
    const missing = await call("GET", `/api/v1/orgs/${owner.slug}/${pub}/nope`);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("HEAD answers like GET without a body", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/${pub}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("fixed: ?depth= resolves $refs into collections the reader can't see", async () => {
    // withRefResolution/resolveDocRefs look up referenced documents in any collection
    // of the org without an access check, so a public document that references a
    // private one exposes the private data.
    const leak = `leak${stamp}`;
    const id = (await call("POST", `/api/v1/${leak}`, { cookie: owner.cookie, body: { author: { $ref: priv, $id: privId } } })).json.id;
    await call("POST", `/api/v1/${leak}/${id}/labels`, { cookie: owner.cookie, body: { label: "published" } });
    await rule(owner.cookie, { principal: "*", resource: `collection:${leak}`, access: "read", labelFilter: "published" });
    expect((await call("GET", `/api/v1/orgs/${owner.slug}/${priv}/${privId}`)).status).toBe(403);
    const r = await call("GET", `/api/v1/orgs/${owner.slug}/${leak}/${id}?depth=1`);
    expect(r.text).not.toContain("top-secret-salary");
    expect(r.json.data.author).toEqual({ $ref: priv, $forbidden: true });
  });
});

describe("authenticated responses are never shared-cacheable", () => {
  it("sessions, keys and errors on /api/v1 are private, no-store", async () => {
    const k = await newKey(owner.cookie, "cache");
    const responses = [
      await call("GET", "/api/v1/me", { cookie: owner.cookie }),
      await call("GET", `/api/v1/${pub}`, { key: k.key }),
      await call("GET", `/api/v1/${pub}/${pubId}`, { key: k.key }),
      await call("GET", `/api/v1/${pub}/nope`, { key: k.key }),
      await call("GET", "/api/v1/me"),
    ];
    for (const r of responses) expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("API keys act in their own org", () => {
  it("a key only ever sees its own org's data", async () => {
    const theirs = `theirs${stamp}`;
    await call("POST", `/api/v1/${theirs}`, { cookie: outsider.cookie, body: { mine: true } });
    const k = await newKey(owner.cookie, "own-org");
    expect((await call("GET", `/api/v1/${theirs}`, { key: k.key })).json.items).toEqual([]);
    expect((await call("GET", `/api/v1/${pub}/${pubId}`, { key: (await newKey(outsider.cookie, "x")).key })).status).toBe(404);
  });
});

describe("CORS", () => {
  const preflight = (path: string, origin: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE_URL}${path}`, { method: "OPTIONS", headers: { Origin: origin, ...headers } });

  it("preflights are 204 with the allowed methods and headers", async () => {
    const res = await preflight("/api/v1/me", foreign);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("a foreign origin may call the API with a key, but never gets credentials", async () => {
    const k = await newKey(owner.cookie, "cors");
    const r = await call("GET", "/api/v1/me", { key: k.key, origin: foreign });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(foreign);
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(r.headers.get("vary")).toContain("Origin");
  });

  it("a trusted origin gets credentials on the API", async () => {
    const r = await call("GET", "/api/v1/me", { cookie: owner.cookie, origin: BASE_URL });
    expect(r.headers.get("access-control-allow-origin")).toBe(BASE_URL);
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("an origin matching the request's Host is trusted (reverse proxies)", async () => {
    const host = new URL(BASE_URL).host;
    const res = await preflight("/api/v1/me", `https://${host}`);
    expect(res.headers.get("access-control-allow-origin")).toBe(`https://${host}`);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("outside /api/v1 a foreign origin is not allowed", async () => {
    for (const path of ["/mcp", "/profile", "/api/auth/get-session"]) {
      const res = await preflight(path, foreign);
      expect(res.headers.get("access-control-allow-origin") ?? "").toBe("");
    }
  });

  it("public routes say * even to foreign origins, without credentials", async () => {
    for (const path of [`/orgs/${owner.slug}/${pub}`, `/api/v1/orgs/${owner.slug}/${pub}`, "/api/v1/projects"]) {
      const r = await call("GET", path, { origin: foreign });
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("session cookies are HttpOnly and SameSite=Lax", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });

  it("fixed: cookie-carrying auth POSTs from a foreign Origin are accepted", async () => {
    // e.g. a cross-site sign-out (logout CSRF). Browsers don't send SameSite=Lax
    // cookies on cross-site POSTs, which limits this, but the server doesn't check.
    const { signIn } = await import("../setup");
    const fresh = (await signIn(owner.email, owner.password)).cookie;
    const r = await call("POST", "/api/auth/sign-out", { cookie: fresh, origin: foreign, body: {} });
    expect(r.status).toBe(403);
    expect((await call("GET", "/api/v1/me", { cookie: fresh })).status).toBe(200);
  });
});

describe("org llms.txt", () => {
  it("anonymous: only public collections and published samples, cacheable", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/llms.txt`);
    const text = await res.text();
    expect(text).toContain(pub);
    expect(text).toContain("pub-v1");
    expect(text).not.toContain("pub-v2-draft");
    expect(text).not.toContain("top-secret-salary");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("an authenticated non-member gets the public view", async () => {
    const res = await fetch(`${BASE_URL}/orgs/${owner.slug}/llms.txt`, { headers: { Cookie: outsider.cookie } });
    const text = await res.text();
    expect(text).not.toContain("top-secret-salary");
    expect(text).toContain("Authenticated data context");
  });

  it("the owner's view includes everything and is private", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/llms.txt`, { headers: { Cookie: owner.cookie } });
    expect(await res.text()).toContain("top-secret-salary");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("unknown orgs are 404", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/orgs/nope-${stamp}/llms.txt`)).status).toBe(404);
  });

  it("an org with no data yet says so", async () => {
    const fresh = await account("fresh", tag);
    const text = await (await fetch(`${BASE_URL}/orgs/${fresh.slug}/llms.txt`)).text();
    expect(text).toContain("No collections yet");
    expect(text).toContain(`Full authenticated context: ${BASE_URL}/api/v1/orgs/${fresh.slug}/llms.txt`);
  });

  it("a member with read access gets the authenticated context, kept private", async () => {
    const reader = await account("reader", tag);
    const { viewers } = await groupIds(owner);
    await invite(owner, reader, "member", [viewers]);
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/llms.txt`, { headers: { Cookie: reader.cookie } });
    const text = await res.text();
    expect(text).toContain("Authenticated data context");
    expect(text).toContain(priv);
    expect(text).toContain("API key creation: POST");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an org-wide public rule exposes every collection and tree, with schema summaries", async () => {
    const open = await account("open", tag);
    const c = `openc${stamp}`;
    await call("PUT", `/api/v1/${c}/_schema`, { cookie: open.cookie, body: { schema: { type: "object", properties: { title: { type: "string" }, kind: { type: "string", enum: ["a", "b"] }, any: {} } } } });
    const id = (await call("POST", `/api/v1/${c}`, { cookie: open.cookie, body: { title: "open-doc", kind: "a" } })).json.id;
    await call("PUT", `/api/v1/tree/opent${stamp}/index.html`, { cookie: open.cookie, body: { documentId: id } });
    await call("PUT", `/api/v1/nos${stamp}/_schema`, { cookie: open.cookie, body: { schema: { type: "object" } } });
    await call("POST", `/api/v1/nos${stamp}`, { cookie: open.cookie, body: { name: "named" } });
    await rule(open.cookie, { principal: "*", resource: "*", access: "read" });
    for (const cookie of [undefined, outsider.cookie]) {
      const text = await (await fetch(`${BASE_URL}/orgs/${open.slug}/llms.txt`, { headers: cookie ? { Cookie: cookie } : {} })).text();
      expect(text).toContain(`### ${c} (1 documents)`);
      expect(text).toContain("Schema: any: any, kind: string (enum: a|b), title: string");
      expect(text).toContain("Schema: schema-free");
      expect(text).toContain(`"named"`);
      expect(text).toContain(`### opent${stamp} (1 paths)`);
      const treeLine = text.split("\n").find(l => l.startsWith("/index.html → "));
      expect(treeLine).toEndWith(`/${id}`);
    }
  });

  it("fixed: any member reads every collection's data through llms.txt", async () => {
    // handleOrgLlmsTxt treats every member like the owner: all collections, latest
    // versions, no rules, label or data filters. A member with no access at all (or a
    // narrowed key) gets samples of private documents.
    await invite(owner, member, "member", []);
    await useOrg(member, owner.id);
    expect((await call("GET", `/api/v1/${priv}`, { cookie: member.cookie })).status).toBe(403);
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/llms.txt`, { headers: { Cookie: member.cookie } });
    expect(await res.text()).not.toContain("top-secret-salary");
  });
});

describe("projects directory", () => {
  it("lists orgs with public rules and links their llms.txt", async () => {
    const r = await call("GET", "/api/v1/projects", { origin: null });
    const p = r.json.projects.find((x: any) => x.slug === owner.slug);
    expect(p.url).toBe(`${BASE_URL}/orgs/${owner.slug}/llms.txt`);
    expect(p.collections.map((c: any) => c.name)).toContain(pub);
    expect(r.headers.get("cache-control")).toContain("public");
  });

  it("fixed: collections closed with a public 'none' rule are listed", async () => {
    // handleListProjects selects every principal='*' rule regardless of access.
    const hidden = `payroll${stamp}`;
    await rule(owner.cookie, { principal: "*", resource: `collection:${hidden}`, access: "none" });
    const r = await call("GET", "/api/v1/projects", { origin: null });
    const p = r.json.projects.find((x: any) => x.slug === owner.slug);
    expect(p.collections.map((c: any) => c.name)).not.toContain(hidden);
  });
});

describe("groups and default access", () => {
  it("Viewers can read but not write; members outside groups get 403", async () => {
    const v = await account("viewer", tag);
    const { viewers } = await groupIds(owner);
    await invite(owner, v, "member", [viewers]);
    await useOrg(v, owner.id);
    expect((await call("GET", `/api/v1/${priv}/${privId}`, { cookie: v.cookie })).status).toBe(200);
    expect((await call("PUT", `/api/v1/${priv}/${privId}`, { cookie: v.cookie, body: {} })).status).toBe(403);
    expect((await call("DELETE", `/api/v1/${priv}/${privId}`, { cookie: v.cookie })).status).toBe(403);
  });
});
