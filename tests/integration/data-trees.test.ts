import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-trees+${stamp}@wren.dev`;
const col = `nodes${stamp}`;
const assets = `treeassets${stamp}`;
const tree = `nav${stamp}`;
let cookie: string;
let slug: string;
const ids: Record<string, string> = {};

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const assign = (path: string, documentId?: string, t = tree) =>
  req("PUT", `/api/v1/tree/${t}${path}`, documentId === undefined ? {} : { documentId });

beforeAll(async () => {
  await signUp(email, "secret123", "Data Trees");
  ({ cookie } = await signIn(email, "secret123"));
  slug = (await (await get("/api/v1/me", cookie)).json()).org.slug;
  for (const name of ["home", "blog", "post1", "post2", "deep"]) {
    ids[name] = (await (await post(`/api/v1/${col}`, { title: name }, cookie)).json()).id;
  }
});

describe("tree assignment", () => {
  it("the first PUT on a new tree returns a hint about public access", async () => {
    const res = await assign("/", ids.home);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tree, path: "/", documentId: ids.home });
    expect(body.hint.created_tree).toBe(tree);
    expect(body.hint.message).toContain("not publicly readable");
    expect(body.hint.public_read_example.body).toEqual({ principal: "*", resource: `tree:${tree}`, access: "read" });
  });

  it("later PUTs on the same tree have no hint", async () => {
    for (const [p, d] of [["/blog", ids.blog], ["/blog/post1", ids.post1], ["/blog/post2", ids.post2], ["/blog/post2/deep", ids.deep]]) {
      const body = await (await assign(p, d)).json();
      expect(body.hint).toBeUndefined();
    }
  });

  it("the hint says so when a public rule already covers the tree", async () => {
    const pubTree = `pubtree${stamp}`;
    await post("/api/v1/permissions", { principal: "*", resource: `tree:${pubTree}`, access: "read" }, cookie);
    const body = await (await assign("/index", ids.home, pubTree)).json();
    expect(body.hint.message).toContain("A public read rule already covers it");
    expect(body.hint.public_read_example).toBeUndefined();
  });

  it("PUT without a documentId creates an empty folder", async () => {
    const body = await (await assign("/empty")).json();
    expect(body.documentId).toBeNull();
  });

  it("assigning an unknown document is a 404, not a 500", async () => {
    const res = await assign("/missing", `unknown-${stamp}`);
    expect(res.status).toBe(404);
  });

  it("a tree name is required for writes", async () => {
    const res = await req("PUT", `/api/v1/tree/`, { documentId: ids.home });
    expect(res.status).toBe(400);
  });

  it("unsupported methods are 405", async () => {
    expect((await req("PATCH", `/api/v1/tree/${tree}/blog`, {})).status).toBe(405);
  });
});

describe("tree reads", () => {
  it("lists trees with their path counts", async () => {
    const { trees } = await (await get("/api/v1/tree", cookie)).json();
    expect(trees.find((t: any) => t.name === tree)).toEqual({ name: tree, count: 6 });
  });

  it("?full=true returns every assigned node with its document", async () => {
    const res = await get(`/api/v1/tree/${tree}?full=true`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe(tree);
    // The empty folder has no document, so it isn't a node
    expect(body.nodes.map((n: any) => n.path)).toEqual(["/", "/blog", "/blog/post1", "/blog/post2", "/blog/post2/deep"]);
    expect(body.nodes[1].document).toMatchObject({ id: ids.blog, collection: col, version: 1, data: { title: "blog" } });
  });

  it("?full=true&label= returns only documents carrying the label, at that version", async () => {
    await post(`/api/v1/${col}/${ids.post1}/labels`, { label: "published" }, cookie);
    await req("PUT", `/api/v1/${col}/${ids.post1}`, { title: "post1 draft" });
    const body = await (await get(`/api/v1/tree/${tree}?full=true&label=published`, cookie)).json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({ path: "/blog/post1", document: { version: 1, data: { title: "post1" } } });
  });

  it("a node returns its document, assignment doc and descendants", async () => {
    const res = await get(`/api/v1/tree/${tree}/blog`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.json();
    expect(body).toMatchObject({ tree, path: "/blog", pathExists: true, document: { id: ids.blog, collection: col, data: { title: "blog" } } });
    expect(body.assignmentDocId).toBeTruthy();
    expect(body.children.map((c: any) => c.path)).toContain("/blog/post1");
    expect(body.children.find((c: any) => c.path === "/blog/post2").documentId).toBe(ids.post2);
  });

  it("children are every path below the node, at any depth", async () => {
    // A deep path needn't have a row for each folder above it, so the node lists all of them
    const body = await (await get(`/api/v1/tree/${tree}/blog`, cookie)).json();
    expect(body.children.map((c: any) => c.path)).toEqual(["/blog/post1", "/blog/post2", "/blog/post2/deep"]);
  });

  it("_ and % in a path match themselves, not as wildcards", async () => {
    const t = `wild${stamp}`;
    await assign("/a_b/x", ids.post1, t);
    await assign("/aXb/y", ids.post2, t);
    // Paths are stored as they appear in the URL, so "%" arrives as "%25"; unescaped, the
    // "%" would also match "/5xx25/…"
    await assign("/5%25/z", ids.deep, t);
    await assign("/5xx25/w", ids.home, t);
    const under = async (p: string) => (await (await get(`/api/v1/tree/${t}${p}`, cookie)).json()).children.map((c: any) => c.path);
    expect(await under("/a_b")).toEqual(["/a_b/x"]);
    expect(await under("/5%25")).toEqual(["/5%25/z"]);
  });

  it("?label= on a node resolves the labeled version", async () => {
    const body = await (await get(`/api/v1/tree/${tree}/blog/post1?label=published`, cookie)).json();
    expect(body.document).toMatchObject({ version: 1, data: { title: "post1" } });
    const current = await (await get(`/api/v1/tree/${tree}/blog/post1`, cookie)).json();
    expect(current.document.data.title).toBe("post1 draft");
  });

  it("a node whose document lacks the label is 404 when it has no children", async () => {
    expect((await get(`/api/v1/tree/${tree}/blog/post2/deep?label=published`, cookie)).status).toBe(404);
    // ...but a folder with children is still listed
    const folder = await get(`/api/v1/tree/${tree}/blog?label=published`, cookie);
    expect(folder.status).toBe(200);
    expect((await folder.json()).document).toBeNull();
  });

  it("an unknown path is a 404 that isn't cached", async () => {
    const res = await get(`/api/v1/tree/${tree}/nope`, cookie);
    expect(res.status).toBe(404);
  });

  it("an empty folder with no children is a 404", async () => {
    expect((await get(`/api/v1/tree/${tree}/empty`, cookie)).status).toBe(404);
  });

  it("a path shared by two trees resolves per tree", async () => {
    const other = `other${stamp}`;
    await assign("/blog", ids.home, other);
    const a = await (await get(`/api/v1/tree/${tree}/blog`, cookie)).json();
    const b = await (await get(`/api/v1/tree/${other}/blog`, cookie)).json();
    expect(a.document.id).toBe(ids.blog);
    expect(b.document.id).toBe(ids.home);
  });

  it("reassigning a path points it at the new document", async () => {
    const t = `reassign${stamp}`;
    await assign("/page", ids.home, t);
    const first = await (await get(`/api/v1/tree/${t}/page`, cookie)).json();
    await assign("/page", ids.blog, t);
    const second = await (await get(`/api/v1/tree/${t}/page`, cookie)).json();
    expect(second.document.id).toBe(ids.blog);
    // The assignment history lives on the same tracking document
    expect(second.assignmentDocId).toBe(first.assignmentDocId);
    const hist = await (await get(`/api/v1/_paths/${second.assignmentDocId}/versions`, cookie)).json();
    expect(hist.versions).toHaveLength(2);
  });
});

describe("binary files in trees", () => {
  let fileId: string;

  beforeAll(async () => {
    const form = new FormData();
    form.append("file", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
    const res = await fetch(`${BASE_URL}/api/v1/${assets}`, { method: "POST", headers: { Origin: BASE_URL, Cookie: cookie }, body: form });
    fileId = (await res.json()).id;
    await assign("/index.html", fileId, `site${stamp}`);
  });

  it("serves raw bytes by default and JSON metadata on Accept: application/json", async () => {
    const html = await fetch(`${BASE_URL}/api/v1/tree/site${stamp}/index.html`, { headers: { Origin: BASE_URL, Cookie: cookie, Accept: "text/html" } });
    expect(html.headers.get("content-type")).toStartWith("text/html");
    expect(await html.text()).toBe("<h1>hi</h1>");

    const noAccept = await fetch(`${BASE_URL}/api/v1/tree/site${stamp}/index.html`, { headers: { Origin: BASE_URL, Cookie: cookie } });
    expect(await noAccept.text()).toBe("<h1>hi</h1>");

    const json = await (await get(`/api/v1/tree/site${stamp}/index.html`, cookie)).json();
    expect(json.document.data).toMatchObject({ _binary: true, filename: "index.html" });
  });
});

describe("removing paths", () => {
  it("DELETE removes the path and records a tombstone on the assignment doc", async () => {
    const before = await (await get(`/api/v1/tree/${tree}/blog/post2/deep`, cookie)).json();
    const res = await req("DELETE", `/api/v1/tree/${tree}/blog/post2/deep`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tree, path: "/blog/post2/deep", removed: true });
    expect((await get(`/api/v1/tree/${tree}/blog/post2/deep`, cookie)).status).toBe(404);

    const tomb = await (await get(`/api/v1/_paths/${before.assignmentDocId}`, cookie)).json();
    expect(tomb.data).toEqual({ tree, path: "/blog/post2/deep", documentId: null, removed: true });
    // The document itself is untouched
    expect((await get(`/api/v1/${col}/${ids.deep}`, cookie)).status).toBe(200);
  });

  it("DELETE of an empty folder works and a second DELETE is a 404", async () => {
    expect((await req("DELETE", `/api/v1/tree/${tree}/empty`)).status).toBe(200);
    expect((await req("DELETE", `/api/v1/tree/${tree}/empty`)).status).toBe(404);
  });

  it("a deleted document disappears from tree reads", async () => {
    const t = `deleted${stamp}`;
    const { id } = await (await post(`/api/v1/${col}`, { title: "temp" }, cookie)).json();
    await assign("/temp", id, t);
    await req("DELETE", `/api/v1/${col}/${id}`);
    expect((await get(`/api/v1/tree/${t}/temp`, cookie)).status).toBe(404);
    expect((await (await get(`/api/v1/tree/${t}?full=true`, cookie)).json()).nodes).toEqual([]);
  });
});

describe("POST /api/v1/tree/{name}/_promote", () => {
  it("defaults the label to published and reports what moved", async () => {
    const t = `promo${stamp}`;
    await assign("/a", ids.home, t);
    await assign("/b", ids.blog, t);
    const res = await req("POST", `/api/v1/tree/${t}/_promote`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tree: t, label: "published", from: null });
    expect(body.promoted.map((p: any) => [p.path, p.collection])).toEqual(expect.arrayContaining([["/a", col], ["/b", col]]));
    const home = await (await get(`/api/v1/${col}/${ids.home}?label=published`, cookie)).json();
    expect(home.version).toBe(1);
  });

  it("an empty tree is a 404", async () => {
    const res = await req("POST", `/api/v1/tree/nothing${stamp}/_promote`, { label: "live" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("is empty");
  });

  it("a blank label falls back to published", async () => {
    const t = `promo2${stamp}`;
    await assign("/x", ids.post2, t);
    const body = await (await req("POST", `/api/v1/tree/${t}/_promote`, { label: "  " })).json();
    expect(body.label).toBe("published");
  });
});

describe("public tree reads", () => {
  const pubTree = `public${stamp}`;

  beforeAll(async () => {
    await assign("/page", ids.post1, pubTree);
    await post("/api/v1/permissions", { principal: "*", resource: `tree:${pubTree}`, access: "read", labelFilter: "published" }, cookie);
  });

  it("serves the published version on both public URL shapes", async () => {
    for (const path of [`/api/v1/orgs/${slug}/tree/${pubTree}/page`, `/orgs/${slug}/tree/${pubTree}/page`]) {
      const res = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "application/json" } });
      expect(res.status).toBe(200);
      expect((await res.json()).document.data.title).toBe("post1");
    }
  });

  it("?full=true publicly, with the rule's label winning over ?label=", async () => {
    const body = await (await fetch(`${BASE_URL}/api/v1/orgs/${slug}/tree/${pubTree}?full=true&label=other`)).json();
    expect(body.nodes.map((n: any) => n.document.data.title)).toEqual(["post1"]);
  });

  it("a tree without a public rule is 403; writes are 405", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${slug}/tree/${tree}/blog`)).status).toBe(403);
    expect((await post(`/api/v1/orgs/${slug}/tree/${pubTree}/page`, {})).status).toBe(405);
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${slug}/tree`)).status).toBe(400);
  });
});
