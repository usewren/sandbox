import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, signUp, signIn } from "../setup";

const stamp = Date.now();
const H = (cookie?: string, key?: string) => ({
  "Content-Type": "application/json", Accept: "application/json", Origin: BASE_URL,
  ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}),
});
async function call(method: string, path: string, opts: { cookie?: string; key?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: H(opts.cookie, opts.key), body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: any = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function account(name: string) {
  const email = `${name}+${stamp}@wren.dev`;
  await signUp(email, "secret123", name);
  const { cookie } = await signIn(email, "secret123");
  const me = (await call("GET", "/api/v1/me", { cookie })).json;
  return { email, cookie, id: me.user.id as string, slug: me.org.slug as string };
}
async function invite(owner: { cookie: string }, who: { email: string; cookie: string; id: string }, role: string, groupIds: string[]) {
  const inv = (await call("POST", "/api/v1/invites", { cookie: owner.cookie, body: { email: who.email, role, groupIds } })).json;
  const acc = await call("POST", "/api/v1/invites/accept", { cookie: who.cookie, body: { token: inv.token } });
  return { inv, acc };
}
async function useOrg(user: { cookie: string }, orgId: string) {
  return call("PUT", "/api/v1/org", { cookie: user.cookie, body: { orgId } });
}

let owner: Awaited<ReturnType<typeof account>>;
let anna: Awaited<ReturnType<typeof account>>;
let ben: Awaited<ReturnType<typeof account>>;
let viewers: string, editors: string;
const col = `data${stamp}`;

beforeAll(async () => {
  owner = await account("owner");
  anna = await account("anna");
  ben = await account("ben");
  await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { title: "seed" } });
  const groups = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups;
  viewers = groups.find((g: any) => g.name === "Viewers").id;
  editors = groups.find((g: any) => g.name === "Editors").id;
});

describe("permission rules are per org", () => {
  it("two orgs can both make a tree called 'site' public without touching each other", async () => {
    const tree = `site${stamp}`;
    const a = await call("POST", "/api/v1/permissions", { cookie: owner.cookie, body: { principal: "*", resource: `tree:${tree}`, access: "read", labelFilter: "published" } });
    const b = await call("POST", "/api/v1/permissions", { cookie: anna.cookie, body: { principal: "*", resource: `tree:${tree}`, access: "read" } });
    expect(a.status).toBeLessThan(300); expect(b.status).toBeLessThan(300);
    expect(b.json.id).not.toBe(a.json.id);
    const mine = (await call("GET", "/api/v1/permissions", { cookie: owner.cookie })).json.permissions.find((p: any) => p.resource === `tree:${tree}`);
    expect(mine.labelFilter).toBe("published");   // org A's rule untouched
  });
});

describe("groups", () => {
  it("every org starts with Editors (write) and Viewers (read)", async () => {
    const groups = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups;
    expect(groups.find((g: any) => g.name === "Editors").rules[0]).toMatchObject({ resource: "*", access: "write" });
    expect(groups.find((g: any) => g.name === "Viewers").rules[0]).toMatchObject({ resource: "*", access: "read" });
  });

  it("an invite puts the person in the chosen groups: Viewers can read, not write", async () => {
    const { acc } = await invite(owner, anna, "member", [viewers]);
    expect(acc.status).toBe(200);
    await useOrg(anna, owner.id);
    const me = (await call("GET", "/api/v1/me", { cookie: anna.cookie })).json;
    expect(me.groups.map((g: any) => g.name)).toEqual(["Viewers"]);
    expect((await call("GET", `/api/v1/${col}`, { cookie: anna.cookie })).status).toBe(200);
    expect((await call("POST", `/api/v1/${col}`, { cookie: anna.cookie, body: { x: 1 } })).status).toBe(403);
  });

  it("adding someone to Editors lets them write", async () => {
    expect((await call("PUT", `/api/v1/groups/${editors}/members/${anna.id}`, { cookie: owner.cookie })).status).toBe(200);
    expect((await call("POST", `/api/v1/${col}`, { cookie: anna.cookie, body: { by: "anna" } })).status).toBe(201);
  });

  it("invites reject unknown roles and other orgs' groups", async () => {
    expect((await call("POST", "/api/v1/invites", { cookie: owner.cookie, body: { email: "x@wren.dev", role: "owner" } })).status).toBe(400);
    const foreign = (await call("GET", "/api/v1/groups", { cookie: ben.cookie })).json.groups[0].id;
    expect((await call("POST", "/api/v1/invites", { cookie: owner.cookie, body: { email: "y@wren.dev", groupIds: [foreign] } })).status).toBe(400);
  });
});

describe("keys act as their creator", () => {
  let annaKey: string, annaKeyId: string;
  it("a member can create a key; it has the member's access", async () => {
    const k = (await call("POST", "/api/v1/keys", { cookie: anna.cookie, body: { name: "anna-script" } })).json;
    annaKey = k.key; annaKeyId = k.id;
    expect(annaKey).toStartWith("wren_");
    expect((await call("POST", `/api/v1/${col}`, { key: annaKey, body: { via: "key" } })).status).toBe(201);
  });

  it("rules on the key narrow it", async () => {
    await call("POST", "/api/v1/permissions", { cookie: owner.cookie, body: { principal: `key:${annaKeyId}`, resource: `collection:${col}`, access: "read" } });
    expect((await call("GET", `/api/v1/${col}`, { key: annaKey })).status).toBe(200);
    expect((await call("POST", `/api/v1/${col}`, { key: annaKey, body: {} })).status).toBe(403);
  });

  it("members only see and revoke their own keys", async () => {
    await call("POST", "/api/v1/keys", { cookie: owner.cookie, body: { name: "owner-key" } });
    const annaList = (await call("GET", "/api/v1/keys", { cookie: anna.cookie })).json.keys.map((k: any) => k.name);
    expect(annaList).toEqual(["anna-script"]);
  });
});

describe("impersonation", () => {
  it("only admins can start it, and never as the owner", async () => {
    await invite(owner, ben, "admin", []);
    await useOrg(ben, owner.id);
    expect((await call("POST", `/api/v1/members/${owner.id}/impersonate`, { cookie: ben.cookie })).status).toBe(403);
    await useOrg(anna, owner.id);
    expect((await call("POST", `/api/v1/members/${ben.id}/impersonate`, { cookie: anna.cookie })).status).toBe(403);   // anna is a member, not admin
  });

  it("an admin acts as the member; changes are recorded as impersonated", async () => {
    const start = await call("POST", `/api/v1/members/${anna.id}/impersonate`, { cookie: ben.cookie });
    expect(start.status).toBe(200);
    const me = (await call("GET", "/api/v1/me", { cookie: ben.cookie })).json;
    expect(me.user.id).toBe(anna.id);
    expect(me.impersonating.by.userId).toBe(ben.id);
    // anna's key-narrowing doesn't apply to her session; she's in Editors → write works
    const doc = (await call("POST", `/api/v1/${col}`, { cookie: ben.cookie, body: { by: "ben-as-anna" } })).json;
    const versions = (await call("GET", `/api/v1/${col}/${doc.id}/versions`, { cookie: owner.cookie })).json;
    const v = (versions.versions ?? versions)[0];
    expect(v.createdBy).toBe(anna.id);
    expect(v.impersonatedBy).toBe(ben.id);
  });

  it("org management is blocked while impersonating", async () => {
    for (const path of ["/api/v1/permissions", "/api/v1/keys", "/api/v1/members", "/api/v1/groups", "/api/v1/org"]) {
      expect((await call("GET", path, { cookie: ben.cookie })).status).toBe(403);
    }
  });

  it("ending it restores the admin's own identity", async () => {
    expect((await call("DELETE", "/api/v1/impersonation", { cookie: ben.cookie })).json.ended).toBe(true);
    const me = (await call("GET", "/api/v1/me", { cookie: ben.cookie })).json;
    expect(me.user.id).toBe(ben.id);
    expect(me.impersonating).toBeNull();
  });

  it("removing a member stops their keys", async () => {
    const k = (await call("POST", "/api/v1/keys", { cookie: anna.cookie, body: { name: "doomed" } })).json.key;
    expect((await call("GET", `/api/v1/${col}`, { key: k })).status).toBe(200);
    await call("DELETE", `/api/v1/members/${anna.id}`, { cookie: owner.cookie });
    expect((await call("GET", `/api/v1/${col}`, { key: k })).status).toBe(403);
  });
});
