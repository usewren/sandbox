import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, type Account } from "./access-helpers";

// 0.9.0: unchanged writes create no version, labels can be removed, documents can be
// undeleted, a collection or tree can be restored to a label in one transaction,
// diffs go deep and take labels, ISO dates range-filter, files can be addressed by
// name, and a file rollback restores the bytes too.
const stamp = Date.now();
let owner: Account;
const H = () => ({ cookie: owner.cookie });

const upload = async (method: "POST" | "PUT", path: string, bytes: string, name = "a.txt") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "text/plain" }));
  const r = await fetch(`${BASE_URL}${path}`, { method, headers: { Cookie: owner.cookie, Origin: BASE_URL }, body: form });
  return { status: r.status, json: await r.json() as any };
};
const raw = async (path: string) => (await fetch(`${BASE_URL}${path}`, { headers: { Cookie: owner.cookie } })).text();

beforeAll(async () => { owner = await account("v09", `v09${stamp}`); });

describe("unchanged writes", () => {
  it("a PUT with the same data (in any key order) creates no version; ?force=true does", async () => {
    const col = `same${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { a: 1, b: { c: [1, 2] } } })).json.id;
    const again = await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { b: { c: [1, 2] }, a: 1 } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ version: 1, unchanged: true });
    const forced = await call("PUT", `/api/v1/${col}/${id}?force=true`, { ...H(), body: { a: 1, b: { c: [1, 2] } } });
    expect(forced.json.version).toBe(2);
    expect(forced.json.unchanged).toBeUndefined();
    const changed = await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { a: 2, b: { c: [1, 2] } } });
    expect(changed.json.version).toBe(3);
  });

  it("an upsert by key with the same data creates no version", async () => {
    const col = `samek${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "slug" } });
    const first = await call("PUT", `/api/v1/${col}/by-key/x1`, { ...H(), body: { slug: "x1", n: 1 } });
    expect(first.status).toBe(201);
    const again = await call("PUT", `/api/v1/${col}/by-key/x1`, { ...H(), body: { n: 1, slug: "x1" } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ version: 1, unchanged: true, naturalKey: "x1" });
  });
});

describe("labels and undelete", () => {
  it("DELETE removes a label", async () => {
    const col = `unlab${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { v: 1 } })).json.id;
    await call("POST", `/api/v1/${col}/${id}/labels`, { ...H(), body: { label: "snap" } });
    const r = await call("DELETE", `/api/v1/${col}/${id}/labels/snap`, H());
    expect(r.json).toMatchObject({ id, label: "snap", removed: true, version: 1 });
    expect((await call("DELETE", `/api/v1/${col}/${id}/labels/snap`, H())).status).toBe(404);
    expect((await call("GET", `/api/v1/${col}/${id}?label=snap`, H())).status).toBe(404);
  });

  it("undelete brings a document back with its history", async () => {
    const col = `undel${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { v: 1 } })).json.id;
    await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { v: 2 } });
    await call("DELETE", `/api/v1/${col}/${id}`, H());
    expect((await call("GET", `/api/v1/${col}/${id}`, H())).status).toBe(404);
    const r = await call("POST", `/api/v1/${col}/${id}/undelete`, H());
    expect(r.json).toMatchObject({ id, undeleted: true, version: 2 });
    expect((await call("GET", `/api/v1/${col}/${id}`, H())).json.data).toEqual({ v: 2 });
    expect((await call("GET", `/api/v1/${col}/${id}/versions`, H())).json.versions).toHaveLength(2);
    expect((await call("POST", `/api/v1/${col}/${id}/undelete`, H())).status).toBe(404); // not deleted
  });

  it("undelete refuses when another document took the natural key meanwhile", async () => {
    const col = `undelk${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "slug" } });
    const old = (await call("PUT", `/api/v1/${col}/by-key/k`, { ...H(), body: { slug: "k", n: 1 } })).json.id;
    await call("DELETE", `/api/v1/${col}/by-key/k`, H());
    await call("PUT", `/api/v1/${col}/by-key/k`, { ...H(), body: { slug: "k", n: 2 } });
    expect((await call("POST", `/api/v1/${col}/${old}/undelete`, H())).status).toBe(409);
  });
});

describe("restore to a label", () => {
  it("a collection: changed documents get the labeled content, deleted ones come back, new ones go", async () => {
    const col = `rest${stamp}`;
    const a = (await call("POST", `/api/v1/${col}`, { ...H(), body: { name: "a1" } })).json.id;
    const b = (await call("POST", `/api/v1/${col}`, { ...H(), body: { name: "b1" } })).json.id;
    const c = (await call("POST", `/api/v1/${col}`, { ...H(), body: { name: "c1" } })).json.id;
    for (const id of [a, b, c]) await call("POST", `/api/v1/${col}/${id}/labels`, { ...H(), body: { label: "fixture" } });
    // a test run changes things
    await call("PUT", `/api/v1/${col}/${a}`, { ...H(), body: { name: "a2" } });
    await call("DELETE", `/api/v1/${col}/${b}`, H());
    const d = (await call("POST", `/api/v1/${col}`, { ...H(), body: { name: "made by the test" } })).json.id;

    const r = await call("POST", `/api/v1/${col}/_restore`, { ...H(), body: { label: "fixture", deleteUnlabeled: true } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ label: "fixture", restored: 1, undeleted: 1, deleted: 1, unchanged: 1 });
    expect((await call("GET", `/api/v1/${col}/${a}`, H())).json).toMatchObject({ version: 3, data: { name: "a1" } });
    expect((await call("GET", `/api/v1/${col}/${b}`, H())).json.data).toEqual({ name: "b1" });
    expect((await call("GET", `/api/v1/${col}/${d}`, H())).status).toBe(404);
    // without deleteUnlabeled, documents without the label are left alone
    const e = (await call("POST", `/api/v1/${col}`, { ...H(), body: { name: "e" } })).json.id;
    expect((await call("POST", `/api/v1/${col}/_restore`, { ...H(), body: { label: "fixture" } })).json).toMatchObject({ restored: 0, deleted: 0, unchanged: 3 });
    expect((await call("GET", `/api/v1/${col}/${e}`, H())).status).toBe(200);
  });

  it("needs a label that exists", async () => {
    const col = `rest${stamp}`;
    expect((await call("POST", `/api/v1/${col}/_restore`, { ...H(), body: {} })).status).toBe(400);
    expect((await call("POST", `/api/v1/${col}/_restore`, { ...H(), body: { label: "nope" } })).status).toBe(404);
  });

  it("a tree: every mounted document goes back to the label, files included", async () => {
    const tree = `rt${stamp}`, col = `rtpages${stamp}`, files = `rtfiles${stamp}`;
    const page = (await call("POST", `/api/v1/${col}`, { ...H(), body: { title: "v1" } })).json.id;
    const file = await upload("POST", `/api/v1/${files}`, "css v1", "site.css");
    await call("PUT", `/api/v1/tree/${tree}/index.json`, { ...H(), body: { documentId: page } });
    await call("PUT", `/api/v1/tree/${tree}/site.css`, { ...H(), body: { documentId: file.json.id } });
    await call("POST", `/api/v1/tree/${tree}/_promote`, { ...H(), body: { label: "release-1" } });
    await call("PUT", `/api/v1/${col}/${page}`, { ...H(), body: { title: "v2" } });
    await upload("PUT", `/api/v1/${files}/${file.json.id}`, "css v2", "site.css");
    const r = await call("POST", `/api/v1/tree/${tree}/_restore`, { ...H(), body: { label: "release-1" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tree, label: "release-1", restored: 2 });
    expect((await call("GET", `/api/v1/${col}/${page}`, H())).json.data).toEqual({ title: "v1" });
    expect(await raw(`/api/v1/${files}/${file.json.id}/raw`)).toBe("css v1");
  });
});

describe("rollback of a file", () => {
  it("restores the bytes as well as the metadata", async () => {
    const col = `rbf${stamp}`;
    const f = await upload("POST", `/api/v1/${col}`, "first");
    await upload("PUT", `/api/v1/${col}/${f.json.id}`, "second");
    const r = await call("POST", `/api/v1/${col}/${f.json.id}/rollback/1`, H());
    expect(r.json).toMatchObject({ version: 3, rolledBackTo: 1 });
    expect(await raw(`/api/v1/${col}/${f.json.id}/raw`)).toBe("first");
  });
});

describe("diff", () => {
  it("deep=true reports nested changes; labels can stand for versions", async () => {
    const col = `diff${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { a: { b: 1, c: [1, 2] }, x: 1 } })).json.id;
    await call("POST", `/api/v1/${col}/${id}/labels`, { ...H(), body: { label: "before" } });
    await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { a: { b: 2, c: [1, 2, 3] }, x: 1, "a/b": true } });
    const shallow = await call("GET", `/api/v1/${col}/${id}/diff?v1=before&v2=2`, H());
    expect(shallow.json.v1).toBe(1);
    expect(shallow.json.diff.map((d: any) => d.path).sort()).toEqual(["/a", "/a~1b"]);
    const deep = await call("GET", `/api/v1/${col}/${id}/diff?v1=before&v2=2&deep=true`, H());
    expect(deep.json.diff).toEqual(expect.arrayContaining([
      { op: "replace", path: "/a/b", value: 2, oldValue: 1 },
      { op: "add", path: "/a/c/2", value: 3 },
      { op: "add", path: "/a~1b", value: true },
    ]));
    expect(deep.json.diff).toHaveLength(3);
    expect((await call("GET", `/api/v1/${col}/${id}/diff?v1=nope&v2=2`, H())).status).toBe(404);
  });
});

describe("range filters", () => {
  it("ISO dates compare as text, numbers as numbers", async () => {
    const col = `dates${stamp}`;
    for (const [d, n] of [["2026-08-01", 5], ["2026-09-20", 50], ["2026-10-05T09:30:00Z", 500]] as const) {
      await call("POST", `/api/v1/${col}`, { ...H(), body: { day: d, n } });
    }
    const after = await call("GET", `/api/v1/${col}?where=${encodeURIComponent("day>=2026-09-15")}`, H());
    expect(after.json.items.map((i: any) => i.data.day).sort()).toEqual(["2026-09-20", "2026-10-05T09:30:00Z"]);
    const nums = await call("GET", `/api/v1/${col}?where=${encodeURIComponent("n>40")}`, H());
    expect(nums.json.items).toHaveLength(2);
  });
});

describe("files by name", () => {
  it("with naturalKey filename: upsert by key, unchanged re-upload, raw by key, duplicates refused", async () => {
    const col = `byname${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { collectionType: "binary", naturalKey: "filename" } });
    const created = await upload("PUT", `/api/v1/${col}/by-key/logo.svg`, "<svg>1</svg>", "whatever.svg");
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ version: 1, naturalKey: "logo.svg", data: { filename: "logo.svg" } });
    const same = await upload("PUT", `/api/v1/${col}/by-key/logo.svg`, "<svg>1</svg>");
    expect(same.status).toBe(200);
    expect(same.json).toMatchObject({ version: 1, unchanged: true });
    const next = await upload("PUT", `/api/v1/${col}/by-key/logo.svg`, "<svg>2</svg>");
    expect(next.json.version).toBe(2);
    expect(next.json.id).toBe(created.json.id);
    expect(await raw(`/api/v1/${col}/by-key/logo.svg/raw`)).toBe("<svg>2</svg>");
    expect((await call("GET", `/api/v1/${col}/by-key/logo.svg`, H())).json.data.filename).toBe("logo.svg");
    expect((await upload("POST", `/api/v1/${col}`, "dup", "logo.svg")).status).toBe(409);
    expect((await fetch(`${BASE_URL}/api/v1/${col}/by-key/missing.svg/raw`, { headers: { Cookie: owner.cookie } })).status).toBe(404);
  });

  it("without a file key, by-key uploads explain how to set one up", async () => {
    const r = await upload("PUT", `/api/v1/nokey${stamp}/by-key/a.txt`, "x");
    expect(r.status).toBe(400);
    expect(r.json.details).toContain('"naturalKey":"filename"');
  });
});

describe("natural keys on existing documents", () => {
  it("setting naturalKey registers keys for documents that already exist", async () => {
    const col = `latekey${stamp}`;
    const a = (await call("POST", `/api/v1/${col}`, { ...H(), body: { slug: "alpha", n: 1 } })).json.id;
    await call("POST", `/api/v1/${col}`, { ...H(), body: { slug: "beta", n: 2 } });
    await call("POST", `/api/v1/${col}`, { ...H(), body: { n: 3 } }); // no key value: stays unkeyed
    const r = await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "slug" } });
    expect(r.json).toMatchObject({ naturalKey: "slug", keysRegistered: 2 });
    expect((await call("GET", `/api/v1/${col}/by-key/alpha`, H())).json.id).toBe(a);
    const up = await call("PUT", `/api/v1/${col}/by-key/alpha`, { ...H(), body: { slug: "alpha", n: 9 } });
    expect(up.status).toBe(200); // updated, not a duplicate
    expect(up.json.id).toBe(a);
  });

  it("refuses (and changes nothing) when existing documents share a value", async () => {
    const col = `clash${stamp}`;
    await call("POST", `/api/v1/${col}`, { ...H(), body: { slug: "same" } });
    await call("POST", `/api/v1/${col}`, { ...H(), body: { slug: "same" } });
    const r = await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "slug" } });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("'same' ×2");
    expect((await call("GET", `/api/v1/${col}/_schema`, H())).status).toBe(404);
  });

  it("an unchanged re-save still registers a missing key (migration scripts keep working)", async () => {
    const col = `resave${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { slug: "s1" } })).json.id;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "slug" } });
    await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { slug: "s2" } }); // key moves with a real write
    const again = await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { slug: "s2" } });
    expect(again.json).toMatchObject({ unchanged: true, naturalKey: "s2" });
    expect((await call("GET", `/api/v1/${col}/by-key/s2`, H())).json.id).toBe(id);
  });
});
