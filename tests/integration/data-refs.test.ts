import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-refs+${stamp}@wren.dev`;
const authors = `authors${stamp}`;
const cats = `categories${stamp}`;
const posts = `posts${stamp}`;
const tree = `menu${stamp}`;
let cookie: string;
let slug: string;
let annId: string;
let bobId: string;

async function req(method: string, path: string, body?: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const create = async (collection: string, data: unknown) =>
  (await (await post(`/api/v1/${collection}`, data, cookie)).json()).id as string;
const read = async (path: string) => {
  const res = await get(path, cookie);
  expect(res.status).toBe(200);
  return res.json();
};

beforeAll(async () => {
  await signUp(email, "secret123", "Data Refs");
  ({ cookie } = await signIn(email, "secret123"));
  slug = (await (await get("/api/v1/me", cookie)).json()).org.slug;

  annId = await create(authors, { name: "Ann" });
  bobId = await create(authors, { name: "Bob" });
  // Ann's published version is v1, her current one v2
  await post(`/api/v1/${authors}/${annId}/labels`, { label: "published" }, cookie);
  await req("PUT", `/api/v1/${authors}/${annId}`, { name: "Ann (draft)" });

  await req("PUT", `/api/v1/${cats}/_schema`, { schema: { type: "object" }, naturalKey: "slug" });
  await req("PUT", `/api/v1/${cats}/by-key/news`, { label: "News" });

  for (const p of ["/a", "/b", "/c"]) {
    const id = await create(posts, { title: `menu ${p}` });
    await req("PUT", `/api/v1/tree/${tree}${p}`, { documentId: id });
  }
});

describe("$ref resolution", () => {
  it("without ?depth refs are returned as written", async () => {
    const id = await create(posts, { author: { $ref: authors, $id: annId } });
    const doc = await read(`/api/v1/${posts}/${id}`);
    expect(doc.data.author).toEqual({ $ref: authors, $id: annId });
    const zero = await read(`/api/v1/${posts}/${id}?depth=0`);
    expect(zero.data.author).toEqual({ $ref: authors, $id: annId });
    const junk = await read(`/api/v1/${posts}/${id}?depth=abc`);
    expect(junk.data.author).toEqual({ $ref: authors, $id: annId });
  });

  it("resolves id refs, key refs and refs inside arrays", async () => {
    const id = await create(posts, {
      title: "hello",
      author: { $ref: authors, $id: annId },
      category: { $ref: cats, $key: "news" },
      reviewers: [{ $ref: authors, $id: bobId }],
    });
    const res = await get(`/api/v1/${posts}/${id}?depth=1`, cookie);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = await res.json();
    expect(doc.data.title).toBe("hello");
    expect(doc.data.author).toEqual({ name: "Ann (draft)" });
    expect(doc.data.category).toEqual({ slug: "news", label: "News" });
    expect(doc.data.reviewers).toEqual([{ name: "Bob" }]);
  });

  it("the same document referenced twice resolves both times (it isn't a cycle)", async () => {
    // Loop detection keeps one "seen" set for the whole document, so a repeat is marked $circular
    const id = await create(posts, { a: { $ref: authors, $id: bobId }, b: { $ref: authors, $id: bobId } });
    const doc = await read(`/api/v1/${posts}/${id}?depth=1`);
    expect(doc.data.b).toEqual({ name: "Bob" });
  });

  it("marks refs that point nowhere", async () => {
    const id = await create(posts, {
      a: { $ref: authors, $id: `missing-${stamp}` },
      b: { $ref: cats, $key: "nope" },
      // Right id, wrong collection
      c: { $ref: cats, $id: annId },
    });
    const doc = await read(`/api/v1/${posts}/${id}?depth=1`);
    expect(doc.data.a).toEqual({ $ref: authors, $id: `missing-${stamp}`, $notFound: true });
    expect(doc.data.b).toEqual({ $ref: cats, $key: "nope", $notFound: true });
    expect(doc.data.c.$notFound).toBe(true);
  });

  it("resolves nested refs up to the depth and stops at cycles", async () => {
    const x = await create(posts, { name: "x" });
    const y = await create(posts, { name: "y", next: { $ref: posts, $id: x } });
    await req("PUT", `/api/v1/${posts}/${x}`, { name: "x", next: { $ref: posts, $id: y } });

    const one = await read(`/api/v1/${posts}/${x}?depth=1`);
    expect(one.data.next.name).toBe("y");
    expect(one.data.next.next).toEqual({ $ref: posts, $id: x });

    const deep = await read(`/api/v1/${posts}/${x}?depth=5`);
    expect(deep.data.next.name).toBe("y");
    expect(deep.data.next.next.name).toBe("x");
    expect(deep.data.next.next.next).toEqual({ $circular: true, $ref: posts });
  });

  it("?label= resolves refs at the labeled version", async () => {
    const id = await create(posts, { author: { $ref: authors, $id: annId } });
    await post(`/api/v1/${posts}/${id}/labels`, { label: "published" }, cookie);
    const doc = await read(`/api/v1/${posts}/${id}?label=published&depth=1`);
    expect(doc.data.author).toEqual({ name: "Ann" });
    // Key refs too: the category only resolves once it carries the label
    const withCat = await create(posts, { category: { $ref: cats, $key: "news" } });
    await post(`/api/v1/${posts}/${withCat}/labels`, { label: "published" }, cookie);
    expect((await read(`/api/v1/${posts}/${withCat}?label=published&depth=1`)).data.category.$notFound).toBe(true);
    const news = await read(`/api/v1/${cats}/by-key/news`);
    await post(`/api/v1/${cats}/${news.id}/labels`, { label: "published" }, cookie);
    expect((await read(`/api/v1/${posts}/${withCat}?label=published&depth=1`)).data.category).toEqual({ slug: "news", label: "News" });
    // Bob has no published version, so under the label he is not found
    const id2 = await create(posts, { author: { $ref: authors, $id: bobId } });
    await post(`/api/v1/${posts}/${id2}/labels`, { label: "published" }, cookie);
    const doc2 = await read(`/api/v1/${posts}/${id2}?label=published&depth=1`);
    expect(doc2.data.author.$notFound).toBe(true);
  });

  it("tree refs inline the nodes under a path, with a limit", async () => {
    const id = await create(posts, {
      all: { $ref: `tree:${tree}` },
      one: { $ref: `tree:${tree}`, $path: "/b" },
    });
    const doc = await read(`/api/v1/${posts}/${id}?depth=1`);
    expect(doc.data.all.map((n: any) => n.path)).toEqual(["/a", "/b", "/c"]);
    expect(doc.data.all[0].data).toEqual({ title: "menu /a" });
    expect(doc.data.one.map((n: any) => n.path)).toEqual(["/b"]);
    const limited = await create(posts, { two: { $ref: `tree:${tree}`, $path: "/", $limit: 2 } });
    expect((await read(`/api/v1/${posts}/${limited}?depth=1`)).data.two).toHaveLength(2);
  });

  it("tree refs under a label only include labeled documents", async () => {
    const { nodes } = await read(`/api/v1/tree/${tree}?full=true`);
    await post(`/api/v1/${posts}/${nodes[2].documentId}/labels`, { label: "published" }, cookie);
    const id = await create(posts, { menu: { $ref: `tree:${tree}` } });
    await post(`/api/v1/${posts}/${id}/labels`, { label: "published" }, cookie);
    const doc = await read(`/api/v1/${posts}/${id}?label=published&depth=1`);
    expect(doc.data.menu.map((n: any) => n.path)).toEqual(["/c"]);
  });

  it("query refs inline items or aggregate rows", async () => {
    const id = await create(posts, {
      names: { $ref: `query:${authors}`, $select: ["name"], $where: "name:Bob" },
      stats: { $ref: `query:${authors}`, $q: { aggregate: { groupBy: ["$collection"], metrics: { n: { count: "name" } } } } },
      limited: { $ref: `query:${authors}`, $limit: 1 },
    });
    const doc = await read(`/api/v1/${posts}/${id}?depth=1`);
    expect(doc.data.names.map((i: any) => i.data)).toEqual([{ name: "Bob" }]);
    expect(doc.data.stats).toEqual([{ key: { $collection: authors }, n: 2 }]);
    expect(doc.data.limited).toHaveLength(1);
  });

  it("query refs use the label of the read", async () => {
    const id = await create(posts, { names: { $ref: `query:${authors}`, $select: ["name"] } });
    await post(`/api/v1/${posts}/${id}/labels`, { label: "published" }, cookie);
    const doc = await read(`/api/v1/${posts}/${id}?label=published&depth=1`);
    expect(doc.data.names.map((i: any) => i.data)).toEqual([{ name: "Ann" }]);
  });

  it("a query ref that fails reports the error in place", async () => {
    const id = await create(posts, { bad: { $ref: `query:${authors}`, $where: "garbage" } });
    const doc = await read(`/api/v1/${posts}/${id}?depth=1`);
    expect(doc.data.bad.error).toContain("Invalid filter expression");
  });

  it("list reads resolve refs in every item", async () => {
    const list = `reflist${stamp}`;
    await create(list, { who: { $ref: authors, $id: bobId } });
    await create(list, { who: { $ref: authors, $id: annId } });
    const body = await read(`/api/v1/${list}?depth=1`);
    expect(body.items.map((i: any) => i.data.who.name).sort()).toEqual(["Ann (draft)", "Bob"]);
  });

  it("by-key reads resolve refs", async () => {
    await req("PUT", `/api/v1/${cats}/by-key/sport`, { lead: { $ref: authors, $id: bobId } });
    const doc = await read(`/api/v1/${cats}/by-key/sport?depth=1`);
    expect(doc.data.lead).toEqual({ name: "Bob" });
  });

  it("errors pass through unchanged", async () => {
    const res = await get(`/api/v1/${posts}/missing-${stamp}?depth=1`, cookie);
    expect(res.status).toBe(404);
  });

  it("public reads resolve refs at the rule's label", async () => {
    await post("/api/v1/permissions", { principal: "*", resource: `collection:${posts}`, access: "read", labelFilter: "published" }, cookie);
    // The referenced collection must be public too (else the ref is $forbidden), and
    // it resolves at that collection's rule label (Ann's published version is v1)
    await post("/api/v1/permissions", { principal: "*", resource: `collection:${authors}`, access: "read", labelFilter: "published" }, cookie);
    const id = await create(posts, { author: { $ref: authors, $id: annId } });
    await post(`/api/v1/${posts}/${id}/labels`, { label: "published" }, cookie);
    const doc = await (await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${posts}/${id}?depth=1`)).json();
    expect(doc.data.author).toEqual({ name: "Ann" });
  });
});
