import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, signUp, signIn } from "../setup";

// The OAuth flow an MCP client runs, without a browser: register → authorize (as the
// signed-in user) → WREN consent (pick org) → token → /mcp/login tool calls.
const stamp = Date.now();
const REDIRECT = "http://localhost:8091/callback";
let alice: { cookie: string; id: string }, bob: { cookie: string; id: string; slug: string };
let clientId: string;

async function account(name: string) {
  const email = `${name}+oauth${stamp}@wren.dev`;
  await signUp(email, "secret123", name);
  const { cookie } = await signIn(email, "secret123");
  const me = await (await fetch(`${BASE_URL}/api/v1/me`, { headers: { Cookie: cookie, Origin: BASE_URL } })).json();
  return { email, cookie, id: me.user.id, slug: me.org.slug };
}
async function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  return { verifier, challenge };
}
async function authorize(cookie: string, challenge: string, prompt = true) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "openid offline_access", code_challenge: challenge, code_challenge_method: "S256", state: "s1", ...(prompt ? { prompt: "consent" } : {}) });
  return fetch(`${BASE_URL}/api/auth/mcp/authorize?${q}`, { headers: { Cookie: cookie }, redirect: "manual" });
}
async function consentCode(cookie: string, challenge: string) {
  const loc = (await authorize(cookie, challenge)).headers.get("location")!;
  return new URL(loc, BASE_URL).searchParams.get("consent_code")!;
}
async function mcp(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${BASE_URL}/mcp/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  bob = await account("bob");
  alice = await account("alice") as any;
  const groups = (await (await fetch(`${BASE_URL}/api/v1/groups`, { headers: { Cookie: bob.cookie, Origin: BASE_URL } })).json()).groups;
  const inv = await (await post("/api/v1/invites", { email: (alice as any).email, groupIds: [groups.find((g: any) => g.name === "Editors").id] }, bob.cookie)).json();
  await post("/api/v1/invites/accept", { token: inv.token }, alice.cookie);
  const reg = await (await fetch(`${BASE_URL}/api/auth/mcp/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  })).json();
  clientId = reg.client_id;
});

describe("MCP sign-in (OAuth)", () => {
  it("/mcp/login without a token points clients at the resource metadata", async () => {
    const res = await fetch(`${BASE_URL}/mcp/login`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp/login");
    const meta = await (await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp/login`)).json();
    expect(meta.resource).toEndWith("/mcp/login");
    const as = await (await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`)).json();
    expect(as.registration_endpoint).toContain("/api/auth/mcp/register");
  });

  it("consent can't be skipped", async () => {
    const res = await authorize(alice.cookie, (await pkce()).challenge, false);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("prompt=consent");
  });

  it("someone else can't approve your pending authorization", async () => {
    const code = await consentCode(alice.cookie, (await pkce()).challenge);
    const res = await fetch(`${BASE_URL}/mcp/consent/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: bob.cookie, Origin: BASE_URL },
      body: JSON.stringify({ consent_code: code, client_id: clientId, org_id: bob.id, accept: true }),
    });
    expect(res.status).toBe(400);
  });

  it("you can only pick an org you belong to", async () => {
    const code = await consentCode(bob.cookie, (await pkce()).challenge);
    const res = await fetch(`${BASE_URL}/mcp/consent/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: bob.cookie, Origin: BASE_URL },
      body: JSON.stringify({ consent_code: code, client_id: clientId, org_id: alice.id, accept: true }),
    });
    expect(res.status).toBe(400);
  });

  it("approve for Bob's org → token → tools act as Alice in Bob's org; token is MCP-only", async () => {
    const { verifier, challenge } = await pkce();
    const code = await consentCode(alice.cookie, challenge);
    const info = await (await fetch(`${BASE_URL}/mcp/consent/info?client_id=${clientId}`, { headers: { Cookie: alice.cookie } })).json();
    expect(info.client.name).toBe("Test Agent");
    expect(info.orgs.map((o: any) => o.id)).toContain(bob.id);

    const ok = await (await fetch(`${BASE_URL}/mcp/consent/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: alice.cookie, Origin: BASE_URL },
      body: JSON.stringify({ consent_code: code, client_id: clientId, org_id: bob.id, accept: true }),
    })).json();
    const authCode = new URL(ok.redirectURI).searchParams.get("code")!;
    const tok = await (await fetch(`${BASE_URL}/api/auth/mcp/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
    })).json();
    expect(tok.access_token).toBeTruthy();

    const who = await mcp(tok.access_token, "tools/call", { name: "whoami", arguments: {} });
    expect(who.json.result.structuredContent.user.id).toBe(alice.id);
    expect(who.json.result.structuredContent.org.id).toBe(bob.id);
    const w = await mcp(tok.access_token, "tools/call", { name: "write_document", arguments: { collection: `oauth${stamp}`, data: { by: "alice" } } });
    expect(w.json.result.isError).toBeUndefined();

    expect((await fetch(`${BASE_URL}/api/v1/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).status).toBe(401);
    expect((await mcp("not-a-token", "tools/list")).status).toBe(401);
    accessToken = tok.access_token;
  });

  let accessToken: string;
  it("connected apps: listed with their org, and revoking stops the app immediately", async () => {
    const H = { Cookie: alice.cookie, Origin: BASE_URL };
    const { apps } = await (await fetch(`${BASE_URL}/api/v1/connected-apps`, { headers: H })).json();
    const app = apps.find((a: any) => a.clientId === clientId);
    expect(app.name).toBe("Test Agent");
    expect(app.redirectHosts).toEqual(["localhost:8091"]);
    expect(app.org.id).toBe(bob.id);

    expect((await mcp(accessToken, "tools/list")).status).toBe(200);
    const rev = await fetch(`${BASE_URL}/api/v1/connected-apps/${clientId}`, { method: "DELETE", headers: H });
    expect(rev.status).toBe(200);
    expect((await mcp(accessToken, "tools/list")).status).toBe(401);
    const after = (await (await fetch(`${BASE_URL}/api/v1/connected-apps`, { headers: H })).json()).apps;
    expect(after.some((a: any) => a.clientId === clientId)).toBe(false);
  });

  it("connected apps can't be managed with an API key", async () => {
    const key = (await (await post("/api/v1/keys", { name: "k" }, alice.cookie)).json()).key;
    expect((await fetch(`${BASE_URL}/api/v1/connected-apps`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(403);
  });
});
