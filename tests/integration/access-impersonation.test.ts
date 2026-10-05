import { describe, it, expect, beforeAll } from "bun:test";
import { call, account, invite, useOrg, groupIds, newKey, db, tenant, until, type Account } from "./access-helpers";

// Org-admin impersonation ("view as"): who may start it, what it can reach, and how
// changes made while impersonating are recorded.
const stamp = Date.now();
const tag = `imp${stamp}`;
let owner: Account, ann: Account, tim: Account, vic: Account, out: Account;
const col = `icol${stamp}`;

const start = (by: Account, target: string) => call("POST", `/api/v1/members/${target}/impersonate`, { cookie: by.cookie });
const end = (by: Account) => call("DELETE", "/api/v1/impersonation", { cookie: by.cookie });

beforeAll(async () => {
  owner = await account("owner", tag);
  ann = await account("ann", tag);   // admin
  tim = await account("tim", tag);   // Editors
  vic = await account("vic", tag);   // Viewers
  out = await account("out", tag);   // not in the org
  const { editors, viewers } = await groupIds(owner);
  await invite(owner, ann, "admin", []);
  await invite(owner, tim, "member", [editors]);
  await invite(owner, vic, "member", [viewers]);
  await useOrg(ann, owner.id);
  await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { seed: 1 } });
  await call("POST", `/api/v1/private${stamp}`, { cookie: tim.cookie, body: { mine: "tim's own org" } });
});

describe("starting impersonation", () => {
  it("nothing is active by default", async () => {
    expect((await call("GET", "/api/v1/impersonation", { cookie: ann.cookie })).json).toEqual({ impersonating: null });
    expect((await end(ann)).json).toEqual({ ended: false, reason: "not impersonating" });
    expect((await call("PUT", "/api/v1/impersonation", { cookie: ann.cookie, body: {} })).status).toBe(405);
  });

  it("needs a browser session, not a key", async () => {
    const k = await newKey(ann.cookie, "imp");
    const r = await call("POST", `/api/v1/members/${tim.id}/impersonate`, { key: k.key });
    expect(r.status).toBe(403);
    expect(r.json.error).toContain("session");
  });

  it("not yourself, not the owner, only members of the org", async () => {
    expect((await start(ann, ann.id)).status).toBe(400);
    expect((await start(ann, owner.id)).status).toBe(403);
    expect((await start(ann, out.id)).status).toBe(404);
  });

  it("only inside the admin's current org: in their own org there's nobody to impersonate", async () => {
    await useOrg(ann, ann.id);
    expect((await start(ann, tim.id)).status).toBe(404);
    await useOrg(ann, owner.id);
  });

  it("an admin starts it and acts as the member, pinned to the org", async () => {
    const r = await start(ann, tim.id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ as: { userId: tim.id, email: tim.email }, orgId: owner.id });
    const minutes = (new Date(r.json.expiresAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(55);
    expect(minutes).toBeLessThanOrEqual(60);

    const status = (await call("GET", "/api/v1/impersonation", { cookie: ann.cookie })).json.impersonating;
    expect(status).toMatchObject({ as: { userId: tim.id }, by: { userId: ann.id, email: ann.email }, orgId: owner.id });
    const me = (await call("GET", "/api/v1/me", { cookie: ann.cookie })).json;
    expect(me.user.id).toBe(tim.id);
    expect(me.org.id).toBe(owner.id);
    // tim's own workspace stays out of reach: the session is pinned to the owner's org
    const own = await call("GET", `/api/v1/private${stamp}`, { cookie: ann.cookie });
    expect(own.json.items ?? []).toEqual([]);
  });
});

describe("while impersonating", () => {
  let docId: string;

  it("org management and app connections are blocked", async () => {
    for (const path of ["/api/v1/invites", "/api/v1/webhooks", "/api/v1/connected-apps"]) {
      expect((await call("GET", path, { cookie: ann.cookie })).status).toBe(403);
    }
    expect((await call("PUT", "/api/v1/org", { cookie: ann.cookie, body: { orgId: ann.id } })).status).toBe(403);
    expect((await call("POST", "/api/v1/keys", { cookie: ann.cookie, body: { name: "sneaky" } })).status).toBe(403);
    expect((await call("POST", `/api/v1/members/${vic.id}/impersonate`, { cookie: ann.cookie })).status).toBe(403);
    const consent = await call("GET", "/mcp/consent/info?client_id=x", { cookie: ann.cookie });
    expect(consent.status).toBe(403);
  });

  it("writes record who really made them: versions, labels and paths", async () => {
    docId = (await call("POST", `/api/v1/${col}`, { cookie: ann.cookie, body: { by: "ann-as-tim" } })).json.id;
    await call("PUT", `/api/v1/${col}/${docId}`, { cookie: ann.cookie, body: { by: "ann-as-tim", v: 2 } });
    await call("POST", `/api/v1/${col}/${docId}/labels`, { cookie: ann.cookie, body: { label: "published" } });
    await call("PUT", `/api/v1/tree/isite${stamp}/index.html`, { cookie: ann.cookie, body: { documentId: docId } });

    const versions = (await call("GET", `/api/v1/${col}/${docId}/versions`, { cookie: owner.cookie })).json.versions;
    expect(versions.map((v: any) => [v.createdBy, v.impersonatedBy])).toEqual([[tim.id, ann.id], [tim.id, ann.id]]);
    const schema = tenant(owner.id);
    const [label] = await db()`SELECT created_by, impersonated_by FROM ${db()(schema)}.labels WHERE document_id = ${docId}`;
    expect(label).toEqual({ created_by: tim.id, impersonated_by: ann.id });
    const [path] = await db()`SELECT impersonated_by FROM ${db()(schema)}.paths WHERE document_id = ${docId}`;
    expect(path.impersonated_by).toBe(ann.id);
  });

  it("every request is in the access log with both identities", async () => {
    const q = () => db()`SELECT method, path, status FROM common.access_log
      WHERE org_id = ${owner.id} AND principal = ${"member:" + tim.id} AND resource = ${"impersonated-by:" + ann.id}`;
    const rows = await until(async () => { const r = await q(); return r.length >= 4 ? r : null; }, 3000);
    const seen = (rows as any[]).map(r => `${r.method} ${r.path} ${r.status}`);
    expect(seen).toContain(`POST /api/v1/${col} 201`);
    expect(seen).toContain(`GET /api/v1/invites 403`);
    const startRow = await db()`SELECT status FROM common.access_log WHERE org_id = ${owner.id}
      AND principal = ${"member:" + ann.id} AND resource = ${"impersonation-start:" + tim.id}`;
    expect(startRow.length).toBe(1);
  });

  it("the member's own access applies: a Viewer can't write", async () => {
    expect((await start(owner, vic.id)).status).toBe(200);   // the owner may impersonate too
    expect((await call("GET", `/api/v1/${col}`, { cookie: owner.cookie })).status).toBe(200);
    expect((await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { x: 1 } })).status).toBe(403);
    expect((await end(owner)).json.ended).toBe(true);
    expect((await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { x: 1 } })).status).toBe(201);
  });

  it("fixed: moving an existing label while impersonating isn't recorded as impersonated", async () => {
    // labels.impersonated_by only comes from the column default, so it's set on the
    // first INSERT and kept when ON CONFLICT DO UPDATE moves the label later.
    await useOrg(tim, owner.id);
    const own = (await call("POST", `/api/v1/${col}`, { cookie: tim.cookie, body: { n: 1 } })).json.id;
    await call("POST", `/api/v1/${col}/${own}/labels`, { cookie: tim.cookie, body: { label: "published" } });
    await call("PUT", `/api/v1/${col}/${own}`, { cookie: tim.cookie, body: { n: 2 } });
    // ann (still impersonating tim) moves the label to v2
    await call("POST", `/api/v1/${col}/${own}/labels`, { cookie: ann.cookie, body: { label: "published" } });
    const [label] = await db()`SELECT version, impersonated_by FROM ${db()(tenant(owner.id))}.labels WHERE document_id = ${own}`;
    expect(label.version).toBe(2);
    expect(label.impersonated_by).toBe(ann.id);
  });

  it("a new impersonation can start once the last one ended; only one is active", async () => {
    // end first: management routes (incl. starting) are blocked while impersonating
    await end(ann);
    await start(ann, tim.id);
    await end(ann);
    expect((await start(ann, vic.id)).status).toBe(200);
    expect((await call("GET", "/api/v1/me", { cookie: ann.cookie })).json.user.id).toBe(vic.id);
    const active = await db()`SELECT target_user_id FROM common.impersonations WHERE admin_user_id = ${ann.id} AND ended_at IS NULL`;
    expect(active.map((r: any) => r.target_user_id)).toEqual([vic.id]);
  });
});

describe("ending impersonation", () => {
  it("DELETE ends it, logs it, and restores the admin", async () => {
    const r = await end(ann);
    expect(r.json).toEqual({ ended: true });
    expect((await call("GET", "/api/v1/me", { cookie: ann.cookie })).json.user.id).toBe(ann.id);
    const logged = await until(async () => (await db()`SELECT 1 FROM common.access_log
      WHERE principal = ${"member:" + ann.id} AND resource = ${"impersonation-end:" + vic.id}`).length > 0, 3000);
    expect(logged).toBe(true);
  });

  it("it expires on its own", async () => {
    await start(ann, tim.id);
    await db()`UPDATE common.impersonations SET expires_at = NOW() - INTERVAL '1 second' WHERE admin_user_id = ${ann.id} AND ended_at IS NULL`;
    const me = (await call("GET", "/api/v1/me", { cookie: ann.cookie })).json;
    expect(me.user.id).toBe(ann.id);
    expect(me.impersonating).toBeNull();
  });

  it("removing the member ends any impersonation of them", async () => {
    const tess = await account("tess", tag);
    await invite(owner, tess, "member", []);
    expect((await start(ann, tess.id)).status).toBe(200);
    expect((await call("GET", "/api/v1/me", { cookie: ann.cookie })).json.user.id).toBe(tess.id);
    await call("DELETE", `/api/v1/members/${tess.id}`, { cookie: owner.cookie });
    expect((await call("GET", "/api/v1/me", { cookie: ann.cookie })).json.user.id).toBe(ann.id);
  });

  it("a member (not admin) can't start it", async () => {
    await useOrg(tim, owner.id);
    expect((await start(tim, vic.id)).status).toBe(403);
  });
});
