import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, invite, groupIds, newKey, db, tenant, type Account } from "./access-helpers";

// Files are stored once per distinct content (asset_blobs), unchanged re-uploads
// don't create versions, and retention policies remove old versions while always
// keeping the current one and every labeled one.
const stamp = Date.now();
let owner: Account;
let schema: string;

const upload = async (method: "POST" | "PUT", path: string, bytes: string, name = "a.txt", type = "text/plain") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  const r = await fetch(`${BASE_URL}${path}`, { method, headers: { Cookie: owner.cookie, Origin: BASE_URL }, body: form });
  return { status: r.status, json: await r.json() as any };
};
const blobRows = async (sha: string) =>
  (await db().unsafe(`SELECT count(*)::int AS n FROM ${schema}.asset_blobs WHERE sha256 = $1`, [sha]))[0].n as number;
const versionsOf = async (col: string, id: string) =>
  (await call("GET", `/api/v1/${col}/${id}/versions`, { cookie: owner.cookie })).json.versions.map((v: any) => v.version);

async function docWithVersions(col: string, n: number): Promise<string> {
  const id = (await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { v: 1 } })).json.id;
  for (let v = 2; v <= n; v++) await call("PUT", `/api/v1/${col}/${id}`, { cookie: owner.cookie, body: { v } });
  return id;
}
const label = (col: string, id: string, l: string, version: number) =>
  call("POST", `/api/v1/${col}/${id}/labels`, { cookie: owner.cookie, body: { label: l, version } });
const setPolicy = (target: string, body: unknown) => call("PUT", `/api/v1/retention/${encodeURIComponent(target)}`, { cookie: owner.cookie, body });
const preview = (target: string, body?: unknown) => call("POST", `/api/v1/retention/${encodeURIComponent(target)}/_preview`, { cookie: owner.cookie, body });
const applyNow = () => call("POST", "/api/v1/retention/_apply", { cookie: owner.cookie });

beforeAll(async () => {
  owner = await account("retention", `ret${stamp}`);
  schema = tenant(owner.id);
});

describe("files are stored once per content", () => {
  it("the same bytes in two documents share one blob, and both read back", async () => {
    const col = `files${stamp}`;
    const a = await upload("POST", `/api/v1/${col}`, "same bytes");
    const b = await upload("POST", `/api/v1/${col}`, "same bytes", "b.txt");
    expect(a.json.data.sha256).toBe(b.json.data.sha256);
    expect(await blobRows(a.json.data.sha256)).toBe(1);
    for (const id of [a.json.id, b.json.id]) {
      expect(await (await fetch(`${BASE_URL}/api/v1/${col}/${id}/raw`, { headers: { Cookie: owner.cookie } })).text()).toBe("same bytes");
    }
  });

  it("the database refuses to delete a blob that a version still uses", async () => {
    const col = `guard${stamp}`;
    const a = await upload("POST", `/api/v1/${col}`, "guarded bytes");
    const err = await db().unsafe(`DELETE FROM ${schema}.asset_blobs WHERE sha256 = $1`, [a.json.data.sha256]).catch(e => e);
    expect(err?.code).toBe("23503"); // foreign key violation
    expect(await blobRows(a.json.data.sha256)).toBe(1);
  });

  it("re-uploading an unchanged file creates no version", async () => {
    const col = `reup${stamp}`;
    const a = await upload("POST", `/api/v1/${col}`, "v1 bytes");
    const again = await upload("PUT", `/api/v1/${col}/${a.json.id}`, "v1 bytes");
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ version: 1, unchanged: true });
    // a new name is a change, even with the same bytes
    const renamed = await upload("PUT", `/api/v1/${col}/${a.json.id}`, "v1 bytes", "renamed.txt");
    expect(renamed.json.version).toBe(2);
    expect(renamed.json.unchanged).toBeUndefined();
    const changed = await upload("PUT", `/api/v1/${col}/${a.json.id}`, "v3 bytes", "renamed.txt");
    expect(changed.json.version).toBe(3);
    // old versions still read their own bytes
    expect(await (await fetch(`${BASE_URL}/api/v1/${col}/${a.json.id}/raw?version=1`, { headers: { Cookie: owner.cookie } })).text()).toBe("v1 bytes");
    expect(await (await fetch(`${BASE_URL}/api/v1/${col}/${a.json.id}/raw`, { headers: { Cookie: owner.cookie } })).text()).toBe("v3 bytes");
  });
});

describe("retention policies", () => {
  it("maxVersions keeps the newest n, the current one and labeled ones", async () => {
    const col = `maxv${stamp}`;
    const id = await docWithVersions(col, 6);
    await label(col, id, "published", 2);
    const p = await preview(col, { maxVersions: 2 });
    expect(p.status).toBe(200);
    expect(p.json.total).toMatchObject({ versions: 3, documents: 1 });
    expect(p.json.total.bytes).toBeGreaterThan(0);
    expect(await versionsOf(col, id)).toHaveLength(6); // a preview changes nothing
    expect((await setPolicy(col, { maxVersions: 2 })).status).toBe(200);
    const run = await applyNow();
    expect(run.json.collections.find((c: any) => c.collection === col)).toMatchObject({ versions: 3, documents: 1 });
    expect((await versionsOf(col, id)).sort()).toEqual([2, 5, 6]);
    expect((await call("GET", `/api/v1/${col}/${id}/versions/1`, { cookie: owner.cookie })).status).toBe(404);
    expect((await call("GET", `/api/v1/${col}/${id}?label=published`, { cookie: owner.cookie })).json.data).toEqual({ v: 2 });
  });

  it("labeledOnly keeps only labeled versions (and the current one)", async () => {
    const col = `lab${stamp}`;
    const id = await docWithVersions(col, 5);
    await label(col, id, "published", 3);
    await setPolicy(col, { labeledOnly: true });
    await applyNow();
    expect((await versionsOf(col, id)).sort()).toEqual([3, 5]);
  });

  it("afterLabel removes versions older than the label's version", async () => {
    const col = `after${stamp}`;
    const id = await docWithVersions(col, 6);
    await label(col, id, "published", 4);
    await label(col, id, "audit", 1);
    await setPolicy(col, { afterLabel: "published" });
    await applyNow();
    expect((await versionsOf(col, id)).sort()).toEqual([1, 4, 5, 6]);
    // a document without that label keeps everything under this rule
    const other = await docWithVersions(col, 3);
    await applyNow();
    expect(await versionsOf(col, other)).toHaveLength(3);
  });

  it("maxAgeDays removes versions older than n days", async () => {
    const col = `age${stamp}`;
    const id = await docWithVersions(col, 4);
    await db().unsafe(`UPDATE ${schema}.versions SET created_at = NOW() - interval '40 days' WHERE document_id = $1 AND version IN (1, 2)`, [id]);
    await setPolicy(col, { maxAgeDays: 30 });
    await applyNow();
    expect((await versionsOf(col, id)).sort()).toEqual([3, 4]);
  });

  it("the org default applies to every collection; a collection's own empty policy exempts it", async () => {
    const a = `defa${stamp}`, b = `defb${stamp}`;
    const ida = await docWithVersions(a, 3), idb = await docWithVersions(b, 3);
    await setPolicy(b, {}); // keep everything
    const p = await preview("*", { labeledOnly: true });
    const names = p.json.collections.map((c: any) => c.collection);
    expect(names).toContain(a);
    expect(names).not.toContain(b);
    await setPolicy("*", { labeledOnly: true });
    await applyNow();
    expect(await versionsOf(a, ida)).toEqual([3]);
    expect(await versionsOf(b, idb)).toHaveLength(3);
    await call("DELETE", "/api/v1/retention/*", { cookie: owner.cookie });
  });

  it("removing a file version frees its blob only when nothing else uses it", async () => {
    const col = `blobs${stamp}`;
    const shared = await upload("POST", `/api/v1/${col}`, "shared bytes", "s.txt");
    const f = await upload("POST", `/api/v1/${col}`, "only mine", "f.txt");
    await upload("PUT", `/api/v1/${col}/${f.json.id}`, "shared bytes", "f.txt"); // v2 = same blob as `shared`
    await upload("PUT", `/api/v1/${col}/${f.json.id}`, "newest", "f.txt");      // v3
    await setPolicy(col, { maxVersions: 1 });
    const p = await preview(col);
    expect(p.json.total.versions).toBe(2);
    await applyNow();
    expect(await blobRows(f.json.data.sha256)).toBe(0);      // "only mine" is gone
    expect(await blobRows(shared.json.data.sha256)).toBe(1); // still used by `shared`
    expect(await (await fetch(`${BASE_URL}/api/v1/${col}/${shared.json.id}/raw`, { headers: { Cookie: owner.cookie } })).text()).toBe("shared bytes");
  });

  it("lists policies and runs; delete falls back", async () => {
    const r = await call("GET", "/api/v1/retention", { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(r.json.collections.find((c: any) => c.collection === `maxv${stamp}`)).toMatchObject({ maxVersions: 2, labeledOnly: false, maxAgeDays: null, afterLabel: null });
    expect(r.json.runs.length).toBeGreaterThan(0);
    expect(r.json.runs[0]).toMatchObject({ triggeredBy: owner.id });
    expect((await call("DELETE", `/api/v1/retention/maxv${stamp}`, { cookie: owner.cookie })).json).toEqual({ collection: `maxv${stamp}`, deleted: true });
    expect((await call("DELETE", `/api/v1/retention/maxv${stamp}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("validates policies and targets", async () => {
    for (const body of [{ maxVersions: 0 }, { maxVersions: 1.5 }, { maxAgeDays: -1 }, { labeledOnly: "yes" }, { afterLabel: "" }]) {
      expect((await setPolicy(`val${stamp}`, body)).status).toBe(400);
    }
    expect((await setPolicy("_paths", { labeledOnly: true })).status).toBe(400);
    expect((await call("PUT", "/api/v1/retention/x", { cookie: owner.cookie, body: "not json" as any })).status).toBe(400);
  });

  it("only org admins manage retention; API keys of admins can", async () => {
    const member = await account("retmember", `retm${stamp}`);
    const { editors } = await groupIds(owner);
    await invite(owner, member, "member", [editors]);
    await call("PUT", "/api/v1/org", { cookie: member.cookie, body: { orgId: owner.id } });
    expect((await call("GET", "/api/v1/retention", { cookie: member.cookie })).status).toBe(403);
    expect((await call("POST", "/api/v1/retention/_apply", { cookie: member.cookie })).status).toBe(403);
    const k = await newKey(owner.cookie, "ret");
    expect((await call("GET", "/api/v1/retention", { key: k.key })).status).toBe(200);
  });
});
