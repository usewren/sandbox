import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, groupIds, useOrg, db, verifyEmail, type Account } from "./access-helpers";

// Invites: create, list sent and received, accept by token and by id (bound to the
// invited email), revoke, already-accepted and expired invites.
const stamp = Date.now();
const tag = `inv${stamp}`;
let owner: Account, admin: Account;
let viewers: string;

const send = (from: { cookie: string }, body: Record<string, unknown>) => call("POST", "/api/v1/invites", { cookie: from.cookie, body });
const accept = (who: { cookie: string }, token: string) => call("POST", "/api/v1/invites/accept", { cookie: who.cookie, body: { token } });

beforeAll(async () => {
  owner = await account("owner", tag);
  admin = await account("admin", tag);
  ({ viewers } = await groupIds(owner));
  const inv = await send(owner, { email: admin.email, role: "admin" });
  await accept(admin, inv.json.token);
  await useOrg(admin, owner.id);
});

describe("sending invites", () => {
  it("needs an email; the address is normalized; role defaults to member", async () => {
    expect((await send(owner, {})).status).toBe(400);
    const r = await send(owner, { email: `  Mixed.Case+${stamp}@Wren.DEV ` });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email: `mixed.case+${stamp}@wren.dev`, role: "member", groupIds: [], acceptedAt: null, revokedAt: null });
    expect(r.json.token).toMatch(/^inv_[0-9a-f]{48}$/);
    // no mail transport in tests: the link is returned to share by hand
    expect(r.json.emailSent).toBe(false);
    expect(r.json.acceptUrl).toBe(`${BASE_URL}/admin/#/accept/${r.json.token}`);
    expect(new Date(r.json.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("the address must look like an email", async () => {
    for (const email of ["not-an-email", "a@b", "two words@x.org", "@x.org"]) {
      const r = await call("POST", "/api/v1/invites", { cookie: owner.cookie, body: { email } });
      expect(r.status).toBe(400);
    }
  });

  it("groupIds must be a list of this org's group ids", async () => {
    expect((await send(owner, { email: `g1+${stamp}@wren.dev`, groupIds: "Viewers" })).status).toBe(400);
    expect((await send(owner, { email: `g2+${stamp}@wren.dev`, groupIds: [123] })).status).toBe(400);
    expect((await send(owner, { email: `g3+${stamp}@wren.dev`, groupIds: [viewers, "nope"] })).status).toBe(400);
    const ok = await send(owner, { email: `g4+${stamp}@wren.dev`, groupIds: [viewers, viewers] });
    expect(ok.json.groupIds).toEqual([viewers]);
  });

  it("admins send and list invites for the org; the list never includes tokens", async () => {
    const r = await send(admin, { email: `byadmin+${stamp}@wren.dev`, role: "admin" });
    expect(r.status).toBe(201);
    const list = (await call("GET", "/api/v1/invites", { cookie: owner.cookie })).json.invites;
    const mine = list.find((i: any) => i.id === r.json.id);
    expect(mine).toMatchObject({ email: `byadmin+${stamp}@wren.dev`, role: "admin", acceptedAt: null });
    expect(mine.token).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("inv_");
  });

  it("members can't send or list invites", async () => {
    const m = await account("member", tag);
    const inv = await send(owner, { email: m.email });
    await accept(m, inv.json.token);
    await useOrg(m, owner.id);
    expect((await send(m, { email: `x+${stamp}@wren.dev` })).status).toBe(403);
    expect((await call("GET", "/api/v1/invites", { cookie: m.cookie })).status).toBe(403);
    expect((await call("DELETE", `/api/v1/invites/${inv.json.id}`, { cookie: m.cookie })).status).toBe(403);
  });
});

describe("accepting with the link", () => {
  it("joins the org with the invited role and groups", async () => {
    const v = await account("vera", tag);
    const inv = await send(owner, { email: v.email, role: "member", groupIds: [viewers] });
    const r = await accept(v, inv.json.token);
    expect(r.json).toEqual({ accepted: true, orgId: owner.id });
    await useOrg(v, owner.id);
    const me = (await call("GET", "/api/v1/me", { cookie: v.cookie })).json;
    expect(me.org.role).toBe("member");
    expect(me.groups.map((g: any) => g.name)).toEqual(["Viewers"]);
    // accepted once: the same link is spent
    expect((await accept(v, inv.json.token)).status).toBe(409);
    const listed = (await call("GET", "/api/v1/invites", { cookie: owner.cookie })).json.invites.find((i: any) => i.id === inv.json.id);
    expect(listed.acceptedAt).toBeTruthy();
    // and can no longer be revoked
    expect((await call("DELETE", `/api/v1/invites/${inv.json.id}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("an invite to an existing member updates their role", async () => {
    const w = await account("walt", tag);
    await accept(w, (await send(owner, { email: w.email })).json.token);
    await accept(w, (await send(owner, { email: w.email, role: "admin" })).json.token);
    const members = (await call("GET", "/api/v1/members", { cookie: owner.cookie })).json.members;
    expect(members.find((m: any) => m.userId === w.id).role).toBe("admin");
  });

  it("missing, unknown, revoked and expired tokens are refused", async () => {
    const x = await account("xena", tag);
    expect((await call("POST", "/api/v1/invites/accept", { cookie: x.cookie, body: {} })).status).toBe(400);
    expect((await accept(x, "inv_doesnotexist")).status).toBe(404);

    const revoked = await send(owner, { email: x.email });
    const rv = await call("DELETE", `/api/v1/invites/${revoked.json.id}`, { cookie: owner.cookie });
    expect(rv.json).toEqual({ id: revoked.json.id, revoked: true });
    expect((await call("DELETE", `/api/v1/invites/${revoked.json.id}`, { cookie: owner.cookie })).status).toBe(404);
    expect((await accept(x, revoked.json.token)).status).toBe(410);

    const expired = await send(owner, { email: x.email });
    await db()`UPDATE common.invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${expired.json.id}`;
    const r = await accept(x, expired.json.token);
    expect(r.status).toBe(410);
    expect(r.json.error).toContain("expired");
  });

  it("you can't accept an invite to your own org", async () => {
    const inv = await send(owner, { email: owner.email });
    expect((await accept(owner, inv.json.token)).status).toBe(400);
  });

  it("an invite can't be revoked from another org", async () => {
    const other = await account("other", tag);
    const inv = await send(owner, { email: `keep+${stamp}@wren.dev` });
    expect((await call("DELETE", `/api/v1/invites/${inv.json.id}`, { cookie: other.cookie })).status).toBe(404);
  });
});

describe("received invites and accepting by id", () => {
  let yan: Account;

  beforeAll(async () => {
    yan = await account("yan", tag);
    expect(await verifyEmail(yan.email)).toBeLessThan(400);
  });

  it("confirming the email marks the account verified", async () => {
    const s = (await call("GET", "/api/auth/get-session", { cookie: yan.cookie })).json;
    expect(s.user.emailVerified).toBe(true);
  });

  it("a confirmed account sees invites sent to its address, from any org", async () => {
    const other = await account("second", tag);
    const a = await send(owner, { email: yan.email, role: "admin" });
    const b = await send(other, { email: yan.email.toUpperCase() });
    const r = (await call("GET", "/api/v1/invites/received", { cookie: yan.cookie })).json;
    const ids = r.invites.map((i: any) => i.id);
    expect(ids).toEqual(expect.arrayContaining([a.json.id, b.json.id]));
    expect(r.invites.find((i: any) => i.id === a.json.id)).toMatchObject({ orgId: owner.id, orgEmail: owner.email, role: "admin" });
  });

  it("accepts by id without the link", async () => {
    const inv = await send(owner, { email: yan.email, groupIds: [viewers] });
    const r = await call("POST", `/api/v1/invites/${inv.json.id}/accept`, { cookie: yan.cookie });
    expect(r.json).toEqual({ accepted: true, orgId: owner.id });
    expect((await call("POST", `/api/v1/invites/${inv.json.id}/accept`, { cookie: yan.cookie })).status).toBe(409);
    expect((await call("POST", "/api/v1/invites/nope/accept", { cookie: yan.cookie })).status).toBe(404);
  });

  it("by id: only the invited address, and not revoked or expired ones", async () => {
    const forSomeoneElse = await send(owner, { email: `zed+${stamp}@wren.dev` });
    expect((await call("POST", `/api/v1/invites/${forSomeoneElse.json.id}/accept`, { cookie: yan.cookie })).status).toBe(403);

    const revoked = await send(owner, { email: yan.email });
    await call("DELETE", `/api/v1/invites/${revoked.json.id}`, { cookie: owner.cookie });
    expect((await call("POST", `/api/v1/invites/${revoked.json.id}/accept`, { cookie: yan.cookie })).status).toBe(410);

    const expired = await send(owner, { email: yan.email });
    await db()`UPDATE common.invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${expired.json.id}`;
    expect((await call("POST", `/api/v1/invites/${expired.json.id}/accept`, { cookie: yan.cookie })).status).toBe(410);
  });

  it("a confirmed owner can't accept by id into their own org", async () => {
    // the owner's own address invited to their own org
    expect(await verifyEmail(owner.email)).toBeLessThan(400);
    const inv = await send(owner, { email: owner.email });
    expect((await call("POST", `/api/v1/invites/${inv.json.id}/accept`, { cookie: owner.cookie })).status).toBe(400);
  });

  it("unrouted invite methods are 405", async () => {
    expect((await call("PUT", "/api/v1/invites", { cookie: owner.cookie, body: {} })).status).toBe(405);
    expect((await call("GET", "/api/v1/invites/some-id", { cookie: owner.cookie })).status).toBe(405);
  });
});
