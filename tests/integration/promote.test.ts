import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const email = `promote+${Date.now()}@wren.dev`;
const col = `assets${Date.now()}`;
const tree = `site${Date.now()}`;
let cookie: string;
const ids: Record<string, string> = {};

async function req(method: string, path: string, body?: unknown, form?: FormData) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
async function upload(name: string, content: string, id?: string) {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/plain" }));
  const res = await req(id ? "PUT" : "POST", id ? `/api/v1/${col}/${id}` : `/api/v1/${col}`, undefined, form);
  return (await res.json()).id as string;
}
async function labelVersion(id: string, label: string) {
  const doc = await (await get(`/api/v1/${col}/${id}?label=${label}`, cookie)).json();
  return doc.version as number | undefined;
}

beforeAll(async () => {
  await signUp(email, "secret123", "Promote Test");
  ({ cookie } = await signIn(email, "secret123"));
  for (const f of ["a.txt", "b.txt", "c.txt"]) {
    ids[f] = await upload(f, `${f} v1`);
    await req("PUT", `/api/v1/tree/${tree}/${f}`, { documentId: ids[f] });
  }
  // a and b get a v2 labelled preview; c has no preview
  for (const f of ["a.txt", "b.txt"]) {
    await upload(f, `${f} v2`, ids[f]);
    await post(`/api/v1/${col}/${ids[f]}/labels`, { label: "preview" }, cookie);
  }
});

describe("POST /api/v1/tree/{name}/_promote", () => {
  it("promotes the 'from' version of every document in one call", async () => {
    const res = await req("POST", `/api/v1/tree/${tree}/_promote`, { from: "preview" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe("published");
    expect(body.promoted.map((p: any) => p.path).sort()).toEqual(["/a.txt", "/b.txt"]);
    expect(await labelVersion(ids["a.txt"], "published")).toBe(2);
    expect(await labelVersion(ids["b.txt"], "published")).toBe(2);
  });

  it("leaves documents without the 'from' label alone", async () => {
    const res = await get(`/api/v1/${col}/${ids["c.txt"]}?label=published`, cookie);
    expect(res.status).toBe(404);
  });

  it("without 'from' promotes current versions", async () => {
    const res = await req("POST", `/api/v1/tree/${tree}/_promote`, { label: "live" });
    expect(res.status).toBe(200);
    expect((await res.json()).promoted).toHaveLength(3);
    expect(await labelVersion(ids["c.txt"], "live")).toBe(1);
  });

  it("returns 404 when nothing carries the 'from' label", async () => {
    const res = await req("POST", `/api/v1/tree/${tree}/_promote`, { from: "nope" });
    expect(res.status).toBe(404);
  });
});
