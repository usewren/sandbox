import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BASE_URL } from "../setup";

// The OpenAPI spec (docs/openapi.yaml, served at /openapi.json) must describe every
// API route the server answers, and nothing it doesn't. Routes are read from the
// server source: the management routes follow one pattern,
//   if (collection === "webhooks") { if (req.method === "GET" && !id) return …; … }
// and the fixed routes are `url.pathname === "/…"` checks. Website pages (landing
// variants, guides, the admin UI) aren't API and are left out by prefix.
const src = readFileSync(join(import.meta.dir, "../../index.ts"), "utf8");
const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
let specOps: Set<string>, specPaths: Set<string>;

beforeAll(async () => {
  const spec = await (await fetch(`${BASE_URL}/openapi.json`)).json();
  specOps = new Set();
  specPaths = new Set();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    specPaths.add(norm(path));
    for (const m of Object.keys(item)) if (["get", "post", "put", "patch", "delete"].includes(m)) specOps.add(`${m.toUpperCase()} ${norm(path)}`);
  }
});

/** "METHOD /api/v1/name[/…]" for each `if (collection === "name")` block in index.ts. */
function managementRoutes(): Set<string> {
  const out = new Set<string>();
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {4}if \(collection === "([a-z_-]+)"(.*)\) \{\s*$/);
    if (!m) continue;
    const [, name, blockCond] = m;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^ {4}\}\s*$/.test(lines[j]); j++) body.push(lines[j]);
    const entries: { methods: string[]; cond: string }[] = [];
    body.forEach((l, k) => {
      if (!/^\s*if \(/.test(l)) return;
      const methods = [...l.matchAll(/req\.method === "(\w+)"/g)].map(x => x[1]);
      if (methods.length && /\breturn\b/.test(l + (body[k + 1] ?? ""))) entries.push({ methods, cond: l });
    });
    if (!entries.length) {
      const methods = [...blockCond.matchAll(/req\.method === "(\w+)"/g)].map(x => x[1]);
      if (methods.length) entries.push({ methods, cond: "" });
    }
    for (const { methods, cond } of entries) {
      const c = `${blockCond} ${cond}`;
      let path = `/api/v1/${name}`;
      const idLit = c.match(/\bid === "([^"]+)"/);
      if (idLit) path += `/${idLit[1]}`;
      else if (/(^|[^!\w.])id\b/.test(c.replace(/!id\b/g, ""))) path += "/{}";
      const subLit = c.match(/\bsub === "([^"]+)"/);
      if (subLit) path += `/${subLit[1]}`;
      if (/\bmemberId\b/.test(c)) path += "/{}";
      for (const meth of methods) out.add(`${meth} ${path}`);
    }
  }
  return out;
}

const API_PREFIXES = ["/api/", "/mcp", "/.well-known/"];
const DISCOVERY = ["/health", "/openapi.json", "/llms.txt", "/llms-full.txt", "/robots.txt", "/sitemap.xml", "/wren.js"];

describe("OpenAPI spec matches the server", () => {
  it("finds the management routes in the source (parser sanity check)", () => {
    const r = managementRoutes();
    expect(r.has("GET /api/v1/webhooks")).toBe(true);
    expect(r.has("PUT /api/v1/groups/{}/members/{}")).toBe(true);
    expect(r.has("POST /api/v1/members/{}/impersonate")).toBe(true);
    expect(r.size).toBeGreaterThan(30);
  });

  it("documents every management route with its method", () => {
    const missing = [...managementRoutes()].filter(op => !specOps.has(op));
    expect(missing).toEqual([]);
  });

  it("documents no management route the server doesn't have", () => {
    const names = new Set([...managementRoutes()].map(op => op.split(" ")[1].split("/")[3]));
    const routes = managementRoutes();
    const extra = [...specOps].filter(op => {
      const seg = op.split(" ")[1].split("/");
      // tree and orgs (public data) routes have their own structure; the data API is covered elsewhere
      return seg[1] === "api" && seg[2] === "v1" && names.has(seg[3]) && !["tree", "orgs"].includes(seg[3]) && !routes.has(op);
    });
    expect(extra).toEqual([]);
  });

  it("documents every fixed API and discovery path", () => {
    const fixed = new Set([...src.matchAll(/url\.pathname === "([^"]+)"/g)].map(m => m[1]));
    const missing = [...fixed].filter(p =>
      (API_PREFIXES.some(pre => p.startsWith(pre)) || DISCOVERY.includes(p)) && !specPaths.has(norm(p)));
    expect(missing).toEqual([]);
  });

  it("is well-formed: every $ref resolves, responses have only known keys, security is a list", async () => {
    const spec = await (await fetch(`${BASE_URL}/openapi.json`)).json();
    const problems: string[] = [];
    const walk = (node: any, at: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
      if (!node || typeof node !== "object") return;
      if (typeof node.$ref === "string") {
        const target = node.$ref.replace(/^#\//, "").split("/").reduce((o: any, k: string) => o?.[k], spec);
        if (target === undefined) problems.push(`${at}: ${node.$ref} doesn't exist`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${at}/${k}`);
    };
    walk(spec, "#");
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
        if (op.security !== undefined && !Array.isArray(op.security)) problems.push(`${m} ${path}: security must be a list`);
        for (const [code, res] of Object.entries<any>(op.responses ?? {})) {
          // A comma inside an unquoted inline YAML description turns the rest into keys
          const extra = Object.keys(res).filter(k => !["description", "content", "headers", "links", "$ref"].includes(k));
          if (extra.length) problems.push(`${m} ${path} ${code}: unexpected ${extra.join(", ")}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every documented operation has a summary and responses", async () => {
    const spec = await (await fetch(`${BASE_URL}/openapi.json`)).json();
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
        if (!op.summary || !op.responses || !Object.keys(op.responses).length) bad.push(`${m.toUpperCase()} ${path}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
