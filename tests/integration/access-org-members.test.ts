import { describe, it, expect, beforeAll } from "bun:test";
import { call, account, invite, useOrg, groupIds, newKey, rule, type Account } from "./access-helpers";

// Org context (switching, slugs, usage), members and roles, and groups.
const stamp = Date.now();
const tag = `org${stamp}`;
let owner: Account, ada: Account, bo: Account, cy: Account;
let editors: string, viewers: string;

beforeAll(async () => {
  owner = await account("owner", tag);
  ada = await account("ada", tag);   // admin
  bo = await account("bo", tag);     // member
  cy = await account("cy", tag);     // outsider
  ({ editors, viewers } = await groupIds(owner));
  await invite(owner, ada, "admin", [editors]);
  await invite(owner, bo, "member", [viewers]);
});

describe("org context", () => {
  it("lists your own workspace and the orgs you belong to", async () => {
    const org = (await call("GET", "/api/v1/org", { cookie: ada.cookie })).json;
    expect(org.current).toBe(ada.id);
    expect(org.orgs[0]).toMatchObject({ id: ada.id, name: "My workspace", own: true, slug: ada.slug });
    const theirs = org.orgs.find((o: any) => o.id === owner.id);
    expect(theirs).toMatchObject({ own: false, slug: owner.slug, email: owner.email });
  });

  it("switching is per session and only into orgs you belong to", async () => {
    expect((await call("PUT", "/api/v1/org", { cookie: ada.cookie, body: {} })).status).toBe(400);
    expect((await useOrg(ada, cy.id)).status).toBe(403);
    expect((await useOrg(ada, owner.id)).json).toEqual({ current: owner.id });
    expect((await call("GET", "/api/v1/org", { cookie: ada.cookie })).json.current).toBe(owner.id);
    // a second session of the same person is unaffected
    const { signIn } = await import("../setup");
    const other = (await signIn(ada.email, ada.password)).cookie;
    expect((await call("GET", "/api/v1/org", { cookie: other })).json.current).toBe(ada.id);
    // switching back to your own org always works
    expect((await call("PUT", "/api/v1/org", { cookie: other, body: { orgId: ada.id } })).status).toBe(200);
  });

  it("/me reports the role in the current org", async () => {
    await useOrg(bo, owner.id);
    const me = (await call("GET", "/api/v1/me", { cookie: bo.cookie })).json;
    expect(me.org).toMatchObject({ id: owner.id, slug: owner.slug, role: "member" });
    expect(me.authMethod).toBe("session");
    expect(me.principal).toBe(`member:${bo.id}`);
    expect(me.permissions.some((p: any) => p.principal === `group:${viewers}`)).toBe(true);
    const own = (await call("GET", "/api/v1/me", { cookie: owner.cookie })).json;
    expect(own.org.role).toBe("owner");
  });

  it("only GET and PUT on /org", async () => {
    expect((await call("DELETE", "/api/v1/org", { cookie: owner.cookie })).status).toBe(405);
    expect((await call("POST", "/api/v1/me", { cookie: owner.cookie, body: {} })).status).toBe(405);
  });
});

describe("slugs", () => {
  it("the owner can rename the org's slug; the public URL follows", async () => {
    const slug = `acme-${stamp}`;
    const pub = `slugcol${stamp}`;
    await call("POST", `/api/v1/${pub}`, { cookie: owner.cookie, body: { hi: 1 } });
    await rule(owner.cookie, { principal: "*", resource: `collection:${pub}`, access: "read" });
    const r = await call("PUT", "/api/v1/org/slug", { cookie: owner.cookie, body: { slug } });
    expect(r.json).toEqual({ slug });
    expect((await call("GET", "/api/v1/me", { cookie: owner.cookie })).json.org.slug).toBe(slug);
    expect((await call("GET", `/api/v1/orgs/${slug}/${pub}`, { origin: null })).status).toBe(200);
    expect((await call("GET", `/api/v1/orgs/${owner.slug}/${pub}`, { origin: null })).status).toBe(404);
    owner.slug = slug;
  });

  it("slugs are validated and unique", async () => {
    for (const slug of ["", "ab", "-lead", "trail-", "UPPER", "under_score", "x".repeat(41)]) {
      const r = await call("PUT", "/api/v1/org/slug", { cookie: cy.cookie, body: { slug } });
      expect(r.status).toBe(400);
    }
    const taken = await call("PUT", "/api/v1/org/slug", { cookie: cy.cookie, body: { slug: owner.slug } });
    expect(taken.status).toBe(409);
  });

  it("only the owner sets it, and only with PUT", async () => {
    // ada is an admin in the owner's org but still can't rename it
    const r = await call("PUT", "/api/v1/org/slug", { cookie: ada.cookie, body: { slug: `nope-${stamp}` } });
    expect(r.status).toBe(403);
    expect((await call("GET", "/api/v1/org/slug", { cookie: owner.cookie })).status).toBe(405);
  });
});

describe("usage", () => {
  it("reports disk and request counts for the current org", async () => {
    const col = `usage${stamp}`;
    await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { n: 1 } });
    await call("GET", `/api/v1/${col}`, { cookie: owner.cookie });
    const u = (await call("GET", "/api/v1/org/usage", { cookie: owner.cookie })).json;
    expect(u.disk.bytes).toBeGreaterThan(0);
    expect(u.requests.last30Days.reads).toBeGreaterThanOrEqual(1);
    expect(u.requests.last30Days.writes).toBeGreaterThanOrEqual(1);
    expect(u.requests.daily[0].date).toBe(new Date().toISOString().split("T")[0]);
    // cached on the second call
    expect((await call("GET", "/api/v1/org/usage", { cookie: owner.cookie })).json.disk.bytes).toBe(u.disk.bytes);
    expect((await call("POST", "/api/v1/org/usage", { cookie: owner.cookie, body: {} })).status).toBe(405);
  });

  it("fixed: someone removed from an org still reads its usage", async () => {
    // GET /api/v1/org/usage doesn't check membership; a removed member's session
    // still points at the org.
    const gone = await account("gone", tag);
    await invite(owner, gone, "member", []);
    await useOrg(gone, owner.id);
    await call("DELETE", `/api/v1/members/${gone.id}`, { cookie: owner.cookie });
    expect((await call("GET", "/api/v1/org/usage", { cookie: gone.cookie })).status).toBe(403);
  });
});

describe("members and roles", () => {
  it("admins list members with their role and groups; members can't", async () => {
    await useOrg(ada, owner.id);
    const list = (await call("GET", "/api/v1/members", { cookie: ada.cookie })).json.members;
    const a = list.find((m: any) => m.userId === ada.id), b = list.find((m: any) => m.userId === bo.id);
    expect(a).toMatchObject({ role: "admin", email: ada.email, groups: [{ id: editors, name: "Editors" }] });
    expect(b).toMatchObject({ role: "member", groups: [{ id: viewers, name: "Viewers" }] });
    expect((await call("GET", "/api/v1/members", { cookie: bo.cookie })).status).toBe(403);
  });

  it("what a member may not manage, an admin may", async () => {
    await useOrg(bo, owner.id);
    for (const path of ["/api/v1/members", "/api/v1/invites", "/api/v1/groups", "/api/v1/permissions", "/api/v1/webhooks"]) {
      expect((await call("GET", path, { cookie: bo.cookie })).status).toBe(403);
      expect((await call("GET", path, { cookie: ada.cookie })).status).toBe(200);
    }
    expect((await call("POST", "/api/v1/invites", { cookie: bo.cookie, body: { email: `z${stamp}@wren.dev` } })).status).toBe(403);
    expect((await call("POST", "/api/v1/groups", { cookie: bo.cookie, body: { name: "mine" } })).status).toBe(403);
    expect((await call("DELETE", `/api/v1/members/${ada.id}`, { cookie: bo.cookie })).status).toBe(403);
  });

  it("removing members: not yourself, not someone outside the org", async () => {
    expect((await call("DELETE", `/api/v1/members/${ada.id}`, { cookie: ada.cookie })).status).toBe(400);
    expect((await call("DELETE", `/api/v1/members/${cy.id}`, { cookie: ada.cookie })).status).toBe(404);
    expect((await call("DELETE", `/api/v1/members/${owner.id}`, { cookie: ada.cookie })).status).toBe(404);
  });

  it("an admin removes a member: groups go too, the org disappears from their list", async () => {
    const dan = await account("dan", tag);
    await invite(owner, dan, "member", [editors]);
    const r = await call("DELETE", `/api/v1/members/${dan.id}`, { cookie: ada.cookie });
    expect(r.json).toEqual({ userId: dan.id, removed: true });
    const groups = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups;
    expect(groups.find((g: any) => g.id === editors).members.some((m: any) => m.userId === dan.id)).toBe(false);
    expect((await call("GET", "/api/v1/org", { cookie: dan.cookie })).json.orgs.map((o: any) => o.id)).toEqual([dan.id]);
  });

  it("members routes only accept the documented methods", async () => {
    expect((await call("PUT", `/api/v1/members/${bo.id}`, { cookie: owner.cookie, body: {} })).status).toBe(405);
    expect((await call("POST", "/api/v1/members", { cookie: owner.cookie, body: {} })).status).toBe(405);
  });
});

describe("groups", () => {
  let team: string;

  it("create: name required, access validated, names unique", async () => {
    expect((await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: {} })).status).toBe(400);
    expect((await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: "x", access: "root" } })).status).toBe(400);
    const g = await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `Team ${stamp}`, description: "d", access: "write" } });
    expect(g.status).toBe(201);
    expect(g.json).toMatchObject({ name: `Team ${stamp}`, description: "d" });
    team = g.json.id;
    expect((await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `Team ${stamp}` } })).status).toBe(409);
    const listed = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups.find((x: any) => x.id === team);
    expect(listed.rules).toEqual([expect.objectContaining({ resource: "*", access: "write", labelFilter: null })]);
  });

  it("rename and describe; clashing names and unknown groups are refused", async () => {
    const r = await call("PUT", `/api/v1/groups/${team}`, { cookie: owner.cookie, body: { name: `Crew ${stamp}` } });
    expect(r.json).toEqual({ id: team, updated: true });
    await call("PUT", `/api/v1/groups/${team}`, { cookie: owner.cookie, body: { description: "new" } });
    const g = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups.find((x: any) => x.id === team);
    expect(g).toMatchObject({ name: `Crew ${stamp}`, description: "new" });
    expect((await call("PUT", `/api/v1/groups/${team}`, { cookie: owner.cookie, body: { name: "Editors" } })).status).toBe(409);
    expect((await call("PUT", "/api/v1/groups/no-such-group", { cookie: owner.cookie, body: { name: "y" } })).status).toBe(404);
  });

  it("only members of the org can join its groups; access follows the group", async () => {
    const col = `grp${stamp}`;
    const eve = await account("eve", tag);
    await invite(owner, eve, "member", []);
    await useOrg(eve, owner.id);
    expect((await call("POST", `/api/v1/${col}`, { cookie: eve.cookie, body: {} })).status).toBe(403);
    expect((await call("PUT", `/api/v1/groups/${team}/members/${cy.id}`, { cookie: owner.cookie })).status).toBe(400);
    expect((await call("PUT", `/api/v1/groups/${team}/members/${owner.id}`, { cookie: owner.cookie })).status).toBe(400);
    expect((await call("PUT", `/api/v1/groups/nope/members/${eve.id}`, { cookie: owner.cookie })).status).toBe(404);
    const add = await call("PUT", `/api/v1/groups/${team}/members/${eve.id}`, { cookie: owner.cookie });
    expect(add.json).toEqual({ groupId: team, userId: eve.id, member: true });
    expect((await call("POST", `/api/v1/${col}`, { cookie: eve.cookie, body: {} })).status).toBe(201);
    const del = await call("DELETE", `/api/v1/groups/${team}/members/${eve.id}`, { cookie: owner.cookie });
    expect(del.json.member).toBe(false);
    expect((await call("POST", `/api/v1/${col}`, { cookie: eve.cookie, body: {} })).status).toBe(403);
  });

  it("a group with a narrower rule grants only that", async () => {
    const only = `only${stamp}`;
    const g = (await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `Only ${stamp}` } })).json.id;
    await rule(owner.cookie, { principal: `group:${g}`, resource: `collection:${only}`, access: "write" });
    const fay = await account("fay", tag);
    await invite(owner, fay, "member", [g]);
    await useOrg(fay, owner.id);
    expect((await call("POST", `/api/v1/${only}`, { cookie: fay.cookie, body: {} })).status).toBe(201);
    expect((await call("GET", `/api/v1/other${stamp}`, { cookie: fay.cookie })).status).toBe(403);
    // a key made by a group member carries the group's access
    const k = await newKey(fay.cookie, "fay");
    expect((await call("POST", `/api/v1/${only}`, { key: k.key, body: {} })).status).toBe(201);
  });

  it("deleting a group removes its rules and its members' access", async () => {
    const col = `gone${stamp}`;
    const gid = (await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `Temp ${stamp}`, access: "read" } })).json.id;
    const gus = await account("gus", tag);
    await invite(owner, gus, "member", [gid]);
    await useOrg(gus, owner.id);
    expect((await call("GET", `/api/v1/${col}`, { cookie: gus.cookie })).status).toBe(200);
    expect((await call("DELETE", `/api/v1/groups/${gid}`, { cookie: owner.cookie })).json).toEqual({ id: gid, deleted: true });
    expect((await call("GET", `/api/v1/${col}`, { cookie: gus.cookie })).status).toBe(403);
    const rules = (await call("GET", "/api/v1/permissions", { cookie: owner.cookie })).json.permissions;
    expect(rules.some((p: any) => p.principal === `group:${gid}`)).toBe(false);
    expect((await call("DELETE", `/api/v1/groups/${gid}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("another org's groups can't be touched", async () => {
    const theirs = (await groupIds(cy)).editors;
    expect((await call("PUT", `/api/v1/groups/${theirs}`, { cookie: owner.cookie, body: { name: "hijack" } })).status).toBe(404);
    expect((await call("DELETE", `/api/v1/groups/${theirs}`, { cookie: owner.cookie })).status).toBe(404);
    expect((await call("PUT", `/api/v1/groups/${theirs}/members/${bo.id}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("unrouted group methods are 405", async () => {
    expect((await call("GET", `/api/v1/groups/${editors}`, { cookie: owner.cookie })).status).toBe(405);
    expect((await call("POST", `/api/v1/groups/${editors}/members/${bo.id}`, { cookie: owner.cookie })).status).toBe(405);
  });
});
