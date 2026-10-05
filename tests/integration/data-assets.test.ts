import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { BASE_URL, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-assets+${stamp}@wren.dev`;
const col = `files${stamp}`;
let cookie: string;

async function upload(content: string | Uint8Array, name: string, type: string, id?: string) {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  return fetch(`${BASE_URL}${id ? `/api/v1/${col}/${id}` : `/api/v1/${col}`}`, {
    method: id ? "PUT" : "POST",
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json" },
    body: form,
  });
}
const raw = (path: string) => fetch(`${BASE_URL}${path}`, { headers: { Origin: BASE_URL, Cookie: cookie } });
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  await signUp(email, "secret123", "Data Assets");
  ({ cookie } = await signIn(email, "secret123"));
});

describe("binary assets", () => {
  let id: string;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

  it("multipart upload creates version 1 with file metadata", async () => {
    const res = await upload(png, "logo.png", "image/png");
    expect(res.status).toBe(201);
    const body = await res.json();
    id = body.id;
    expect(body).toMatchObject({ version: 1, collection: col });
    expect(body.data).toEqual({ _binary: true, filename: "logo.png", mimeType: "image/png", size: png.byteLength, sha256: sha(png) });
  });

  it("the document read returns the metadata, not the bytes", async () => {
    const doc = await (await get(`/api/v1/${col}/${id}`, cookie)).json();
    expect(doc.data._binary).toBe(true);
    expect(doc.data.sha256).toBe(sha(png));
  });

  it("raw download returns the exact bytes with type and filename", async () => {
    const res = await raw(`/api/v1/${col}/${id}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="logo.png"');
    expect(res.headers.get("vary")).toContain("Accept");
    // Authenticated responses stay out of shared caches
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("a filename suffix on the raw URL is accepted", async () => {
    const res = await raw(`/api/v1/${col}/${id}/raw/logo.png`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("raw needs authentication", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/${col}/${id}/raw`)).status).toBe(401);
  });

  it("PUT multipart replaces the file as version 2; old versions stay readable", async () => {
    const res = await upload("hello text", "notes.txt", "text/plain", id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
    // Text files carry their charset
    expect(body.data).toMatchObject({ filename: "notes.txt", mimeType: "text/plain;charset=utf-8", size: 10, sha256: sha("hello text") });

    const cur = await raw(`/api/v1/${col}/${id}/raw`);
    expect(cur.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await cur.text()).toBe("hello text");

    const v1 = await raw(`/api/v1/${col}/${id}/raw?version=1`);
    expect(v1.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await v1.arrayBuffer())).toEqual(png);
    expect((await raw(`/api/v1/${col}/${id}/raw?version=9`)).status).toBe(404);
  });

  it("raw with ?label= serves the labeled version", async () => {
    await fetch(`${BASE_URL}/api/v1/${col}/${id}/labels`, {
      method: "POST",
      headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "published", version: 1 }),
    });
    const res = await raw(`/api/v1/${col}/${id}/raw?label=published`);
    expect(res.headers.get("content-type")).toBe("image/png");
    // ?label= wins over ?version=
    const both = await raw(`/api/v1/${col}/${id}/raw?label=published&version=2`);
    expect(both.headers.get("content-type")).toBe("image/png");
    expect((await raw(`/api/v1/${col}/${id}/raw?label=nope`)).status).toBe(404);
  });

  it("a file without a type is stored as application/octet-stream", async () => {
    const body = await (await upload("bytes", "blob", "")).json();
    expect(body.data.mimeType).toBe("application/octet-stream");
    const res = await raw(`/api/v1/${col}/${body.id}/raw`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("an empty file is fine", async () => {
    const body = await (await upload("", "empty.txt", "text/plain")).json();
    expect(body.data.size).toBe(0);
    expect(body.data.sha256).toBe(sha(""));
  });

  it("a form without a file field is a 400", async () => {
    const form = new FormData();
    form.append("other", "value");
    for (const [method, path] of [["POST", `/api/v1/${col}`], ["PUT", `/api/v1/${col}/${id}`]]) {
      const res = await fetch(`${BASE_URL}${path}`, { method, headers: { Origin: BASE_URL, Cookie: cookie }, body: form });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Missing file field");
    }
  });

  it("replacing an unknown or deleted asset is a 404", async () => {
    expect((await upload("x", "x.txt", "text/plain", `unknown-${stamp}`)).status).toBe(404);
    const { id: gone } = await (await upload("x", "x.txt", "text/plain")).json();
    await fetch(`${BASE_URL}/api/v1/${col}/${gone}`, { method: "DELETE", headers: { Origin: BASE_URL, Cookie: cookie } });
    expect((await upload("y", "y.txt", "text/plain", gone)).status).toBe(404);
    expect((await raw(`/api/v1/${col}/${gone}/raw`)).status).toBe(404);
  });

  it("raw on a JSON document is a 404", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/${col}`, {
      method: "POST",
      headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "not a file" }),
    });
    const { id: jsonId } = await res.json();
    expect((await raw(`/api/v1/${col}/${jsonId}/raw`)).status).toBe(404);
  });

  it("version history lists each upload", async () => {
    const body = await (await get(`/api/v1/${col}/${id}/versions`, cookie)).json();
    expect(body.versions.map((v: any) => [v.version, v.labels])).toEqual([[1, ["published"]], [2, []]]);
  });
});
