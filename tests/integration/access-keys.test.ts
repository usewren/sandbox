import { describe, it, expect, beforeAll } from "bun:test";
import { call, account, invite, useOrg, groupIds, newKey, rule, db, until, type Account } from "./access-helpers";

// API keys: create/list/revoke, acting as their creator in the key's org, narrowing
// with key:<id> rules, and rejection of revoked, expired and unknown keys.
const stamp = Date.now();
const tag = `keys${stamp}`;
let owner: Account, amy: Account, max: Account;
const col = `kcol${stamp}`;

beforeAll(async () => {
  owner = await account("owner", tag);
  amy = await account("amy", tag);   // admin
  max = await account("max", tag);   // member in Editors
  const { editors } = await groupIds(owner);
  await invite(owner, amy, "admin", [editors]);
  await invite(owner, max, "member", [editors]);
  await useOrg(amy, owner.id);
  await useOrg(max, owner.id);
  await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { seed: true } });
});

describe("creating and listing keys", () => {
  it("a key needs a name", async () => {
    for (const body of [{}, { name: "   " }]) {
      const r = await call("POST", "/api/v1/keys", { cookie: owner.cookie, body });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("name is required");
    }
  });

  it("the raw key is returned once; lists show only its prefix", async () => {
    const r = await call("POST", "/api/v1/keys", { cookie: owner.cookie, body: { name: " ci " } });
    expect(r.status).toBe(201);
    expect(r.json.key).toMatch(/^wren_[0-9a-f]{48}$/);
    expect(r.json).toMatchObject({ name: "ci", keyPrefix: r.json.key.slice(0, 12), lastUsedAt: null, revokedAt: null });
    const listed = (await call("GET", "/api/v1/keys", { cookie: owner.cookie })).json.keys.find((k: any) => k.id === r.json.id);
    expect(listed).toMatchObject({ name: "ci", keyPrefix: r.json.keyPrefix });
    expect(listed.key).toBeUndefined();
  });

  it("using a key records when it was last used", async () => {
    const k = await newKey(owner.cookie, "used");
    await call("GET", "/api/v1/me", { key: k.key });
    const used = await until(async () =>
      (await call("GET", "/api/v1/keys", { cookie: owner.cookie })).json.keys.find((x: any) => x.id === k.id).lastUsedAt);
    expect(used).toBeTruthy();
  });

  it("/me describes a key caller", async () => {
    const k = await newKey(owner.cookie, "whoami");
    const me = (await call("GET", "/api/v1/me", { key: k.key })).json;
    expect(me.authMethod).toBe("api_key");
    expect(me.principal).toBe(`key:${k.id}`);
    expect(me.apiKey).toMatchObject({ id: k.id, name: "whoami", prefix: k.key.slice(0, 12) });
    expect(me.org).toMatchObject({ id: owner.id, role: "owner", name: "My workspace" });
  });

  it("admins see every key in the org; members only their own", async () => {
    const mk = await newKey(max.cookie, `max-${stamp}`);
    const ak = await newKey(amy.cookie, `amy-${stamp}`);
    const adminView = (await call("GET", "/api/v1/keys", { cookie: amy.cookie })).json.keys.map((k: any) => k.id);
    expect(adminView).toEqual(expect.arrayContaining([mk.id, ak.id]));
    const memberView = (await call("GET", "/api/v1/keys", { cookie: max.cookie })).json.keys.map((k: any) => k.id);
    expect(memberView).toEqual([mk.id]);
  });

  it("only GET, POST and DELETE are routed", async () => {
    expect((await call("PUT", "/api/v1/keys", { cookie: owner.cookie, body: {} })).status).toBe(405);
    expect((await call("DELETE", "/api/v1/keys", { cookie: owner.cookie })).status).toBe(405);
  });
});

describe("revoking keys", () => {
  it("a revoked key stops working at once and leaves the list", async () => {
    const k = await newKey(max.cookie, "revoke-me");
    expect((await call("GET", `/api/v1/${col}`, { key: k.key })).status).toBe(200);
    const r = await call("DELETE", `/api/v1/keys/${k.id}`, { cookie: max.cookie });
    expect(r.json).toEqual({ id: k.id, revoked: true });
    expect((await call("GET", `/api/v1/${col}`, { key: k.key })).status).toBe(401);
    expect((await call("GET", "/api/v1/keys", { cookie: max.cookie })).json.keys.some((x: any) => x.id === k.id)).toBe(false);
    expect((await call("DELETE", `/api/v1/keys/${k.id}`, { cookie: max.cookie })).status).toBe(404);
  });

  it("members can't revoke someone else's key; admins can", async () => {
    const ok = await newKey(owner.cookie, "owner-key");
    const mk = await newKey(max.cookie, "max-key");
    expect((await call("DELETE", `/api/v1/keys/${ok.id}`, { cookie: max.cookie })).status).toBe(404);
    expect((await call("GET", "/api/v1/me", { key: ok.key })).status).toBe(200);
    expect((await call("DELETE", `/api/v1/keys/${mk.id}`, { cookie: amy.cookie })).status).toBe(200);
    expect((await call("GET", "/api/v1/me", { key: mk.key })).status).toBe(401);
  });

  it("a key from another org can't be revoked from here", async () => {
    const stranger = await account("stranger", tag);
    const sk = await newKey(stranger.cookie, "theirs");
    expect((await call("DELETE", `/api/v1/keys/${sk.id}`, { cookie: owner.cookie })).status).toBe(404);
    expect((await call("GET", "/api/v1/me", { key: sk.key })).status).toBe(200);
  });

  it("an expired key is rejected", async () => {
    const k = await newKey(owner.cookie, "expiring");
    expect((await call("GET", "/api/v1/me", { key: k.key })).status).toBe(200);
    await db()`UPDATE common.api_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${k.id}`;
    expect((await call("GET", "/api/v1/me", { key: k.key })).status).toBe(401);
    expect((await call("GET", `/api/v1/${col}`, { key: k.key })).status).toBe(401);
  });

  it("unknown and malformed keys are 401", async () => {
    for (const auth of ["Bearer wren_0000", "Bearer something-else", "Basic abc"]) {
      const r = await call("GET", "/api/v1/me", { headers: { Authorization: auth } });
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("Unauthorized");
    }
  });
});

describe("keys act in their own org", () => {
  it("a member's key made in the owner's org acts there, as the member", async () => {
    const k = await newKey(max.cookie, "in-owner-org");
    const me = (await call("GET", "/api/v1/me", { key: k.key })).json;
    expect(me.org).toMatchObject({ id: owner.id, role: "member" });
    expect(me.user.id).toBe(max.id);
    expect(me.groups.map((g: any) => g.name)).toEqual(["Editors"]);
    const doc = (await call("POST", `/api/v1/${col}`, { key: k.key, body: { by: "max-key" } })).json;
    const v = (await call("GET", `/api/v1/${col}/${doc.id}/versions`, { cookie: owner.cookie })).json.versions[0];
    expect(v.createdBy).toBe(max.id);
  });

  it("the org of a key doesn't follow the creator's session", async () => {
    await useOrg(max, max.id);
    const own = await newKey(max.cookie, "own-org");
    await useOrg(max, owner.id);
    expect((await call("GET", "/api/v1/me", { key: own.key })).json.org.id).toBe(max.id);
    const ownerColList = await call("GET", `/api/v1/${col}`, { key: own.key });
    expect(ownerColList.json.items).toEqual([]);   // max's own (empty) org, not the owner's
  });

  it("a key can't switch orgs", async () => {
    const k = await newKey(max.cookie, "no-switch");
    const r = await call("PUT", "/api/v1/org", { key: k.key, body: { orgId: max.id } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("browser session");
  });

  it("an admin's key manages the key's org, not the admin's own", async () => {
    const k = await newKey(amy.cookie, "admin-key");
    const marker = `collection:adminkey${stamp}`;
    const r = await call("POST", "/api/v1/permissions", { key: k.key, body: { principal: "*", resource: marker, access: "read" } });
    expect(r.status).toBe(201);
    const ownerRules = (await call("GET", "/api/v1/permissions", { cookie: owner.cookie })).json.permissions;
    expect(ownerRules.some((p: any) => p.resource === marker)).toBe(true);
    expect((await call("GET", "/api/v1/org", { key: k.key })).json.current).toBe(owner.id);
    expect((await call("GET", "/api/v1/members", { key: k.key })).status).toBe(200);
  });

  it("a member's key can't manage the org", async () => {
    const k = await newKey(max.cookie, "member-key");
    for (const path of ["/api/v1/permissions", "/api/v1/members", "/api/v1/invites", "/api/v1/groups", "/api/v1/webhooks"]) {
      expect((await call("GET", path, { key: k.key })).status).toBe(403);
    }
  });

  it("someone who left the org can't make or list keys there", async () => {
    const lea = await account("lea", tag);
    await invite(owner, lea, "member", []);
    await useOrg(lea, owner.id);
    expect((await call("POST", "/api/v1/keys", { cookie: lea.cookie, body: { name: "x" } })).status).toBe(201);
    await call("DELETE", `/api/v1/members/${lea.id}`, { cookie: owner.cookie });
    expect((await call("POST", "/api/v1/keys", { cookie: lea.cookie, body: { name: "y" } })).status).toBe(403);
    expect((await call("GET", "/api/v1/keys", { cookie: lea.cookie })).status).toBe(403);
    expect((await call("DELETE", "/api/v1/keys/whatever", { cookie: lea.cookie })).status).toBe(403);
  });
});

describe("key rules narrow a key", () => {
  it("with key:<id> rules a key uses only those, not its creator's groups", async () => {
    const a = `narrowa${stamp}`, b = `narrowb${stamp}`, tree = `narrowt${stamp}`;
    const k = await newKey(max.cookie, "narrow");
    expect((await call("POST", `/api/v1/${b}`, { key: k.key, body: {} })).status).toBe(201);   // Editors
    await rule(owner.cookie, { principal: `key:${k.id}`, resource: `collection:${a}`, access: "write" });
    await rule(owner.cookie, { principal: `key:${k.id}`, resource: `tree:${tree}`, access: "read" });
    const doc = (await call("POST", `/api/v1/${a}`, { key: k.key, body: { ok: 1 } }));
    expect(doc.status).toBe(201);
    expect((await call("GET", `/api/v1/${b}`, { key: k.key })).status).toBe(403);
    expect((await call("PUT", `/api/v1/tree/${tree}/x.html`, { key: k.key, body: { documentId: doc.json.id } })).status).toBe(403);
    expect((await call("GET", `/api/v1/tree/${tree}/x.html`, { key: k.key })).status).not.toBe(403);
    // the creator's own session keeps the Editors access
    expect((await call("GET", `/api/v1/${b}`, { cookie: max.cookie })).status).toBe(200);
    // and /me lists exactly the key's rules (plus public ones)
    const me = (await call("GET", "/api/v1/me", { key: k.key })).json;
    expect(me.permissions.filter((p: any) => p.principal !== "*").map((p: any) => p.resource).sort()).toEqual([`collection:${a}`, `tree:${tree}`]);
  });

  it("fixed: the owner's keys can't be narrowed by key:<id> rules", async () => {
    // Owners bypass rules before the key's own rules are looked at, so a "read-only"
    // key an owner hands to a script still has full write access to the whole org.
    const c = `ownernarrow${stamp}`;
    const k = await newKey(owner.cookie, "read-only-ci");
    await rule(owner.cookie, { principal: `key:${k.id}`, resource: `collection:${c}`, access: "read" });
    expect((await call("GET", `/api/v1/${c}`, { key: k.key })).status).toBe(200);
    expect((await call("POST", `/api/v1/${c}`, { key: k.key, body: { should: "fail" } })).status).toBe(403);
    expect((await call("POST", `/api/v1/other${stamp}`, { key: k.key, body: { should: "fail" } })).status).toBe(403);
  });
});
