import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, type Account } from "./access-helpers";

// 0.10: conditional writes (If-Match / ?ifVersion, ETag on reads), PATCH of a
// collection's schema, and public downloads of files by name.
const stamp = Date.now();
let owner: Account;
const H = () => ({ cookie: owner.cookie });

const upload = async (method: "POST" | "PUT", path: string, bytes: string, name = "a.txt", headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "text/plain" }));
  const r = await fetch(`${BASE_URL}${path}`, { method, headers: { Cookie: owner.cookie, Origin: BASE_URL, ...headers }, body: form });
  return { status: r.status, json: await r.json() as any };
};

beforeAll(async () => { owner = await account("v10", `v10${stamp}`); });

describe("conditional writes", () => {
  it("reads carry the version as an ETag; If-Match with a stale version is refused", async () => {
    const col = `cond${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { n: 1 } })).json.id;
    const read = await call("GET", `/api/v1/${col}/${id}`, H());
    expect(read.headers.get("etag")).toBe('"1"');
    // two writers read v1; the first wins, the second is told to re-read
    const first = await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { n: 2 }, headers: { "If-Match": '"1"' } });
    expect(first.json.version).toBe(2);
    const second = await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { n: 3 }, headers: { "If-Match": '"1"' } });
    expect(second.status).toBe(412);
    expect(second.json).toMatchObject({ error: "Version mismatch", currentVersion: 2 });
    expect((await call("GET", `/api/v1/${col}/${id}`, H())).json.data).toEqual({ n: 2 });
    // ?ifVersion works the same; W/ and unquoted forms are accepted
    expect((await call("PUT", `/api/v1/${col}/${id}?ifVersion=2`, { ...H(), body: { n: 3 } })).json.version).toBe(3);
    expect((await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { n: 4 }, headers: { "If-Match": 'W/"3"' } })).json.version).toBe(4);
  });

  it("deletes can be conditional too", async () => {
    const col = `conddel${stamp}`;
    const id = (await call("POST", `/api/v1/${col}`, { ...H(), body: { n: 1 } })).json.id;
    await call("PUT", `/api/v1/${col}/${id}`, { ...H(), body: { n: 2 } });
    expect((await call("DELETE", `/api/v1/${col}/${id}`, { ...H(), headers: { "If-Match": "1" } })).status).toBe(412);
    expect((await call("DELETE", `/api/v1/${col}/${id}`, { ...H(), headers: { "If-Match": "2" } })).json.deleted).toBe(true);
  });

  it("by key: ifVersion=0 is create-only, If-Match: * only updates", async () => {
    const col = `condkey${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "sku" } });
    expect((await call("PUT", `/api/v1/${col}/by-key/a1?ifVersion=0`, { ...H(), body: { sku: "a1", qty: 5 } })).status).toBe(201);
    // re-running an import must not overwrite live data
    const again = await call("PUT", `/api/v1/${col}/by-key/a1?ifVersion=0`, { ...H(), body: { sku: "a1", qty: 0 } });
    expect(again.status).toBe(412);
    expect(again.json.currentVersion).toBe(1);
    expect((await call("PUT", `/api/v1/${col}/by-key/b2`, { ...H(), body: { sku: "b2" }, headers: { "If-Match": "*" } })).status).toBe(412);
    expect((await call("PUT", `/api/v1/${col}/by-key/a1`, { ...H(), body: { sku: "a1", qty: 4 }, headers: { "If-Match": "*" } })).json.version).toBe(2);
    expect((await call("DELETE", `/api/v1/${col}/by-key/a1?ifVersion=1`, H())).status).toBe(412);
  });

  it("file uploads honor the condition", async () => {
    const col = `condfile${stamp}`;
    const f = await upload("POST", `/api/v1/${col}`, "v1");
    expect((await upload("PUT", `/api/v1/${col}/${f.json.id}`, "v2", "a.txt", { "If-Match": "1" })).json.version).toBe(2);
    const stale = await upload("PUT", `/api/v1/${col}/${f.json.id}`, "v3", "a.txt", { "If-Match": "1" });
    expect(stale.status).toBe(412);
    expect(stale.json.currentVersion).toBe(2);
  });

  it("other origins may send If-Match and read the ETag", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/x`, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "PUT" } });
    expect(r.headers.get("access-control-allow-headers")).toContain("If-Match");
    expect(r.headers.get("access-control-expose-headers")).toContain("ETag");
  });
});

describe("PATCH a schema", () => {
  it("changes only the fields sent", async () => {
    const col = `patch${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { schema: { type: "object", required: ["sku"] }, displayName: "Stock", listColumns: ["sku"] } });
    await call("POST", `/api/v1/${col}`, { ...H(), body: { sku: "p1" } });
    const r = await call("PATCH", `/api/v1/${col}/_schema`, { ...H(), body: { naturalKey: "sku" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ naturalKey: "sku", displayName: "Stock", listColumns: ["sku"], keysRegistered: 1, schema: { required: ["sku"] } });
    // and null clears a field
    expect((await call("PATCH", `/api/v1/${col}/_schema`, { ...H(), body: { displayName: null } })).json).toMatchObject({ displayName: null, naturalKey: "sku" });
  });

  it("rejects unknown fields", async () => {
    const r = await call("PATCH", `/api/v1/patch${stamp}/_schema`, { ...H(), body: { naturalkey: "sku" } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("naturalkey");
  });

  it("creates a schema when there is none yet", async () => {
    const r = await call("PATCH", `/api/v1/patchnew${stamp}/_schema`, { ...H(), body: { collectionType: "binary", naturalKey: "filename" } });
    expect(r.json).toMatchObject({ collectionType: "binary", naturalKey: "filename" });
  });
});

describe("public files by name", () => {
  it("downloads a public file by its name, on both URL shapes", async () => {
    const col = `pubfiles${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { collectionType: "binary", naturalKey: "filename" } });
    await upload("PUT", `/api/v1/${col}/by-key/logo.svg`, "<svg/>");
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${owner.slug}/${col}/by-key/logo.svg/raw`)).status).toBe(403);
    await call("POST", "/api/v1/permissions", { ...H(), body: { principal: "*", resource: `collection:${col}`, access: "read" } });
    for (const base of [`/api/v1/orgs/${owner.slug}`, `/orgs/${owner.slug}`]) {
      const r = await fetch(`${BASE_URL}${base}/${col}/by-key/logo.svg/raw`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("<svg/>");
    }
    expect((await fetch(`${BASE_URL}/orgs/${owner.slug}/${col}/by-key/missing.svg/raw`)).status).toBe(404);
  });

  it("a name without an extension keeps the type it was uploaded with", async () => {
    const col = `noext${stamp}`;
    await call("PUT", `/api/v1/${col}/_schema`, { ...H(), body: { collectionType: "binary", naturalKey: "filename" } });
    // sent with the same file name as the key, as the clients do
    const r = await upload("PUT", `/api/v1/${col}/by-key/notes`, "hello", "notes");
    expect(r.status).toBe(201);
    expect(r.json.data.mimeType).toStartWith("text/plain");
    const raw = await fetch(`${BASE_URL}/api/v1/${col}/by-key/notes/raw`, { headers: { Cookie: owner.cookie } });
    expect(raw.headers.get("content-type")).toStartWith("text/plain");
  });

  it("an upload keeps its declared type, not a guess from its name", async () => {
    const col = `decl${stamp}`;
    const form = new FormData();
    form.append("file", new File(['{"a":1}'], "data.txt", { type: "application/json" }));
    const r = await fetch(`${BASE_URL}/api/v1/${col}`, { method: "POST", headers: { Cookie: owner.cookie, Origin: BASE_URL }, body: form });
    expect(((await r.json()) as any).data.mimeType).toStartWith("application/json");
    // a generic octet-stream still falls back to the name
    const blob = new FormData();
    blob.append("file", new File(["<svg/>"], "logo.svg", { type: "application/octet-stream" }));
    const b = await fetch(`${BASE_URL}/api/v1/${col}`, { method: "POST", headers: { Cookie: owner.cookie, Origin: BASE_URL }, body: blob });
    expect(((await b.json()) as any).data.mimeType).toBe("image/svg+xml");
  });
});
