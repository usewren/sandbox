import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, invite, newKey, rule, type Account } from "./access-helpers";

// MCP edge cases not covered by mcp.test.ts / mcp-oauth.test.ts: JSON-RPC framing,
// sessions instead of keys, read-only and org-bound modes, the OAuth consent endpoints
// and connected apps.
const stamp = Date.now();
const tag = `amcp${stamp}`;
const REDIRECT = "http://localhost:8092/callback";
let owner: Account, ivy: Account;
let key: string;
const col = `mcol${stamp}`;
let docId: string;

async function rpc(body: unknown, opts: { auth?: string | null; cookie?: string; path?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const auth = opts.auth === undefined ? `Bearer ${key}` : opts.auth;
  if (auth) headers.Authorization = auth;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE_URL}${opts.path ?? "/mcp"}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) as any };
}
let n = 1;
const msg = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: n++, method, params });
const tool = async (name: string, args: unknown, opts: { auth?: string | null; cookie?: string; path?: string } = {}) =>
  (await rpc(msg("tools/call", { name, arguments: args }), opts)).json.result;

beforeAll(async () => {
  owner = await account("owner", tag);
  ivy = await account("ivy", tag);
  key = (await newKey(owner.cookie, "mcp")).key;
  docId = (await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { title: "one" } })).json.id;
  await call("PUT", `/api/v1/${col}/${docId}`, { cookie: owner.cookie, body: { title: "two" } });
});

describe("JSON-RPC framing", () => {
  it("ping answers an empty result", async () => {
    const r = await rpc(msg("ping"));
    expect(r.json.result).toEqual({});
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("batches return one reply per request, none for notifications", async () => {
    const r = await rpc([msg("ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, msg("tools/list")]);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json).toHaveLength(2);
    expect(r.json[1].result.tools.length).toBeGreaterThan(0);
    const onlyNotes = await rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(onlyNotes.status).toBe(202);
  });

  it("malformed JSON is a parse error; a malformed message is an invalid request", async () => {
    const parse = await rpc("{not json");
    expect(parse.status).toBe(400);
    expect(parse.json.error.code).toBe(-32700);
    const invalid = await rpc({ id: 9, method: "ping" });
    expect(invalid.json.error.code).toBe(-32600);
  });

  it("unknown protocol versions fall back to the newest", async () => {
    const r = await rpc(msg("initialize", { protocolVersion: "1999-01-01" }));
    expect(r.json.result.protocolVersion).toBe("2025-06-18");
  });

  it("missing arguments and unknown tools are reported", async () => {
    const missing = await tool("diff_versions", { collection: col, id: docId, v2: null });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe("Missing argument(s): v1, v2");
    const unknown = await rpc(msg("tools/call", { name: "drop_database", arguments: {} }));
    expect(unknown.json.error.code).toBe(-32602);
    expect(unknown.json.error.message).toContain("Unknown tool");
  });

  it("GET is refused on the org-bound endpoint too", async () => {
    const res = await fetch(`${BASE_URL}/orgs/${owner.slug}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("keyed tools", () => {
  it("list_collections, list_versions and diff_versions", async () => {
    const cols = await tool("list_collections", {});
    expect(JSON.stringify(cols.structuredContent)).toContain(col);
    const versions = await tool("list_versions", { collection: col, id: docId });
    expect(versions.structuredContent.versions.map((v: any) => v.version)).toEqual([1, 2]);
    const diff = await tool("diff_versions", { collection: col, id: docId, v1: 1, v2: 2 });
    expect(diff.structuredContent.diff).toEqual([{ op: "replace", path: "/title", value: "two", oldValue: "one" }]);
  });

  it("set_label moves a label; list_tree without a name lists trees", async () => {
    const r = await tool("set_label", { collection: col, id: docId, label: "published", version: 1 });
    expect(r.isError).toBeUndefined();
    const got = await call("GET", `/api/v1/${col}/${docId}?label=published`, { cookie: owner.cookie });
    expect(got.json.data.title).toBe("one");
    const bad = await tool("set_label", { collection: col, id: docId, label: "published", version: 99 });
    expect(bad.isError).toBe(true);
    await call("PUT", `/api/v1/tree/mtree${stamp}/index.html`, { cookie: owner.cookie, body: { documentId: docId } });
    const trees = await tool("list_tree", {});
    expect(JSON.stringify(trees.structuredContent)).toContain(`mtree${stamp}`);
  });

  it("a browser session works instead of a key", async () => {
    const who = await tool("whoami", {}, { auth: null, cookie: owner.cookie });
    expect(who.structuredContent.user.id).toBe(owner.id);
  });

  it("readonly on the org-bound endpoint drops write tools and says so", async () => {
    const path = `/orgs/${owner.slug}/mcp?readonly=true`;
    const init = await rpc(msg("initialize", {}), { path });
    expect(init.json.result.instructions).toContain("read-only");
    const names = (await rpc(msg("tools/list"), { path })).json.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_document");
    expect(names).not.toContain("set_label");
    expect(names.some((x: string) => x.startsWith("public_"))).toBe(false);
  });

  it("a key whose creator has no access gets tool errors, not data", async () => {
    await invite(owner, ivy, "member", []);
    await call("PUT", "/api/v1/org", { cookie: ivy.cookie, body: { orgId: owner.id } });
    const ivyKey = (await newKey(ivy.cookie, "ivy")).key;
    const r = await tool("get_document", { collection: col, id: docId }, { auth: `Bearer ${ivyKey}` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("403");
  });
});

describe("org-bound public endpoint", () => {
  it("site_info without a tree describes the org's public data", async () => {
    const pub = `mpub${stamp}`;
    await call("POST", `/api/v1/${pub}`, { cookie: owner.cookie, body: { title: "public-hello" } });
    await rule(owner.cookie, { principal: "*", resource: `collection:${pub}`, access: "read" });
    const r = await tool("site_info", {}, { auth: null, path: `/orgs/${owner.slug}/mcp` });
    expect(r.content[0].text).toContain(pub);
    expect(r.content[0].text).toContain("public-hello");
    expect(r.content[0].text).not.toContain(col);
  });

  it("write tools don't exist there", async () => {
    const r = await rpc(msg("tools/call", { name: "write_document", arguments: { collection: "x", data: {} } }), { auth: null, path: `/orgs/${owner.slug}/mcp` });
    expect(r.json.error.code).toBe(-32602);
  });
});

describe("OAuth consent endpoints", () => {
  let clientId: string;

  beforeAll(async () => {
    const reg = await (await fetch(`${BASE_URL}/api/auth/mcp/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: `Edge ${stamp}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    })).json();
    clientId = reg.client_id;
  });

  async function pkce() {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    return { verifier, challenge };
  }
  async function consentCode(cookie: string, challenge: string) {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "openid offline_access", code_challenge: challenge, code_challenge_method: "S256", state: "s", prompt: "consent" });
    const loc = (await fetch(`${BASE_URL}/api/auth/mcp/authorize?${q}`, { headers: { Cookie: cookie }, redirect: "manual" })).headers.get("location")!;
    return new URL(loc, BASE_URL).searchParams.get("consent_code")!;
  }
  const approve = (cookie: string, body: Record<string, unknown>) =>
    call("POST", "/mcp/consent/approve", { cookie, body });

  it("the consent page is served", async () => {
    const res = await fetch(`${BASE_URL}/mcp/consent?consent_code=x&client_id=y`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("consent info needs a browser session and a known client", async () => {
    expect((await call("GET", `/mcp/consent/info?client_id=${clientId}`)).status).toBe(401);
    expect((await call("GET", `/mcp/consent/info?client_id=${clientId}`, { key })).status).toBe(401);
    expect((await call("GET", "/mcp/consent/info?client_id=nope", { cookie: owner.cookie })).status).toBe(404);
    const info = (await call("GET", `/mcp/consent/info?client_id=${clientId}`, { cookie: ivy.cookie })).json;
    expect(info.client).toMatchObject({ name: `Edge ${stamp}`, redirectHosts: ["localhost:8092"] });
    expect(info.orgs).toEqual([
      expect.objectContaining({ id: ivy.id, role: "owner", name: "My workspace" }),
      expect.objectContaining({ id: owner.id, role: "member", slug: owner.slug }),
    ]);
  });

  it("approve: needs a session and both codes", async () => {
    expect((await call("POST", "/mcp/consent/approve", { body: { consent_code: "x", client_id: clientId } })).status).toBe(401);
    expect((await call("POST", "/mcp/consent/approve", { key, body: { consent_code: "x", client_id: clientId } })).status).toBe(401);
    expect((await approve(owner.cookie, { client_id: clientId })).status).toBe(400);
    expect((await approve(owner.cookie, { consent_code: "made-up", client_id: clientId, org_id: owner.id, accept: true })).status).toBe(400);
  });

  it("accepting without choosing an org is refused", async () => {
    const code = await consentCode(owner.cookie, (await pkce()).challenge);
    const r = await approve(owner.cookie, { consent_code: code, client_id: clientId, accept: true });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("Choose one of your orgs");
  });

  it("denying sends the app back with an error and grants nothing", async () => {
    const code = await consentCode(owner.cookie, (await pkce()).challenge);
    const r = await approve(owner.cookie, { consent_code: code, client_id: clientId, accept: false });
    expect(r.status).toBe(200);
    expect(new URL(r.json.redirectURI).searchParams.get("error")).toBe("access_denied");
    const apps = (await call("GET", "/api/v1/connected-apps", { cookie: owner.cookie })).json.apps;
    expect(apps.some((a: any) => a.clientId === clientId)).toBe(false);
  });

  it("a member removed from the org loses the connection", async () => {
    const { verifier, challenge } = await pkce();
    const code = await consentCode(ivy.cookie, challenge);
    const ok = (await approve(ivy.cookie, { consent_code: code, client_id: clientId, org_id: owner.id, accept: true })).json;
    const authCode = new URL(ok.redirectURI).searchParams.get("code")!;
    const tok = await (await fetch(`${BASE_URL}/api/auth/mcp/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
    })).json();
    const who = await tool("whoami", {}, { auth: `Bearer ${tok.access_token}`, path: "/mcp/login" });
    expect(who.structuredContent.org.id).toBe(owner.id);
    const apps = (await call("GET", "/api/v1/connected-apps", { cookie: ivy.cookie })).json.apps;
    expect(apps.find((a: any) => a.clientId === clientId).org).toMatchObject({ id: owner.id, slug: owner.slug });

    await call("DELETE", `/api/v1/members/${ivy.id}`, { cookie: owner.cookie });
    const r = await rpc(msg("tools/list"), { auth: `Bearer ${tok.access_token}`, path: "/mcp/login" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe(-32003);
  });

  it("/mcp/login refuses API keys and only takes POST", async () => {
    const r = await rpc(msg("tools/list"), { path: "/mcp/login" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(r.json.error.message).toContain("/mcp");
    expect((await fetch(`${BASE_URL}/mcp/login`)).status).toBe(405);
  });

  it("connected apps: unknown ids are 404, other methods 405", async () => {
    expect((await call("DELETE", "/api/v1/connected-apps/nope", { cookie: owner.cookie })).status).toBe(404);
    expect((await call("POST", "/api/v1/connected-apps", { cookie: owner.cookie, body: {} })).status).toBe(405);
    expect((await call("GET", `/api/v1/connected-apps/${clientId}`, { cookie: owner.cookie })).status).toBe(405);
  });

  it("protected-resource metadata is also served at the root path", async () => {
    const r = await call("GET", "/.well-known/oauth-protected-resource");
    expect(r.json.resource).toBe(`${BASE_URL}/mcp/login`);
    expect(r.json.authorization_servers).toEqual([BASE_URL]);
    expect(r.headers.get("cache-control")).toContain("max-age=300");
  });
});
