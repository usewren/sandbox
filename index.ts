import postgres, { type Sql } from "postgres";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { auth } from "auth";
import { setupCommon, createTenant, listTenants, migrateAllTenants, sanitizeSchemaName } from "db/runner";
import Ajv from "ajv";
import { json as jqJson } from "jq-wasm";
import jmespath from "jmespath";
import jsonata from "jsonata";

const ajv = new Ajv({ allErrors: true });

// Plain-JS admin UI — served directly (no build step) from public/admin/
const ADMIN_DIR = join(import.meta.dir, "public", "admin");
const ADMIN_INDEX = join(ADMIN_DIR, "index.html");

// Legacy React admin UI — built by `bun build` into public/oldadmin/
const OLDADMIN_DIR = join(import.meta.dir, "public", "oldadmin");
const OLDADMIN_INDEX = join(OLDADMIN_DIR, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".woff2": "font/woff2",
};

const NO_CACHE = { "Cache-Control": "no-cache, no-store, must-revalidate" };

// Public read policy: short freshness window, long stale-while-revalidate.
// Combined with explicit purges on mutation, this gives near-instant updates
// for editors while still absorbing most read traffic at the CDN.
const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=86400";

// Applied to endpoints that do content negotiation (currently: public tree
// reads, which return either JSON metadata or raw bytes based on Accept).
// Without this header, CDNs cache the first response for every Accept header.
const CONTENT_NEGOTIATED_HEADERS = {
  "Cache-Control": PUBLIC_CACHE,
  "Vary": "Accept",
};
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": PUBLIC_CACHE,
};

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

// -------------------------------------------------------
// Cache purge infrastructure
// -------------------------------------------------------
// An abstraction for telling a CDN to drop cached responses after a mutation.
// Default is a no-op; set CACHE_PURGE_BACKEND=console to log purges to stdout
// for local debugging. A CloudflarePurger implementation can be dropped in
// later without touching any call sites.

interface CachePurger {
  purge(urls: string[]): Promise<void>;
}

class NoopPurger implements CachePurger {
  async purge(_urls: string[]): Promise<void> { /* noop */ }
}

class ConsolePurger implements CachePurger {
  async purge(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    console.log(`[cache] purge ${urls.length} url${urls.length === 1 ? "" : "s"}:`);
    for (const u of urls) console.log(`  ${u}`);
  }
}

// TODO: class CloudflarePurger implements CachePurger {
//   constructor(private zoneId: string, private apiToken: string) {}
//   async purge(urls: string[]) {
//     await fetch(`https://api.cloudflare.com/client/v4/zones/${this.zoneId}/purge_cache`, {
//       method: "POST",
//       headers: { "Authorization": `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
//       body: JSON.stringify({ files: urls }),
//     });
//   }
// }

const cachePurger: CachePurger = (() => {
  const backend = (process.env.CACHE_PURGE_BACKEND ?? "noop").toLowerCase();
  switch (backend) {
    case "console": return new ConsolePurger();
    case "noop":
    default: return new NoopPurger();
  }
})();

function serveAdminFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "Content-Type": type, ...NO_CACHE } });
}

function serveAdminIndex(): Response {
  return new Response(Bun.file(ADMIN_INDEX), { headers: { "Content-Type": "text/html", ...NO_CACHE } });
}

function serveOldAdminFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "Content-Type": type } });
}

function serveOldAdminIndex(): Response {
  return new Response(Bun.file(OLDADMIN_INDEX), { headers: { "Content-Type": "text/html" } });
}

const sql = postgres(process.env.DATABASE_URL ?? "postgres://wren:wren@localhost:5432/wren");

// Set up common schema and warm the known-tenant cache at startup
await setupCommon(sql);
await migrateAllTenants(sql);
const knownTenants = new Set((await listTenants(sql)).map(t => t.org_id));

const openapiPath = process.env.OPENAPI_PATH ?? "../docs/openapi.yaml";
const openapiYaml = await Bun.file(openapiPath).text();
const openapiJson = parseYaml(openapiYaml);

// -------------------------------------------------------
// Request stats — in-memory counters flushed hourly
// -------------------------------------------------------

type StatCounters = { reads: number; writes: number };
const requestStats = new Map<string, StatCounters>();

function trackRequest(orgId: string, isRead: boolean): void {
  let c = requestStats.get(orgId);
  if (!c) { c = { reads: 0, writes: 0 }; requestStats.set(orgId, c); }
  if (isRead) c.reads++; else c.writes++;
}

async function flushRequestStats(): Promise<void> {
  if (requestStats.size === 0) return;
  const entries = Array.from(requestStats.entries());
  requestStats.clear();
  const today = new Date().toISOString().split("T")[0];
  await Promise.all(entries.map(([orgId, c]) =>
    sql`
      INSERT INTO common.request_stats (org_id, date, reads, writes)
      VALUES (${orgId}, ${today}, ${c.reads}, ${c.writes})
      ON CONFLICT (org_id, date) DO UPDATE
        SET reads  = common.request_stats.reads  + EXCLUDED.reads,
            writes = common.request_stats.writes + EXCLUDED.writes
    `.catch(() => {})
  ));
}

setInterval(flushRequestStats, 3_600_000); // flush every hour

// -------------------------------------------------------
// Tenant helpers
// -------------------------------------------------------

async function ensureTenant(orgId: string): Promise<string> {
  if (!knownTenants.has(orgId)) {
    await createTenant(sql, orgId);
    knownTenants.add(orgId);
  }
  return sanitizeSchemaName(orgId);
}

// Returns the org_id (owner userId) this user's session is currently scoped to.
// Priority: API key stored org → explicit per-session preference → auto-select if exactly one membership → own org.
async function resolveUserOrgId(userId: string, sessionId: string | null, keyOrgId?: string): Promise<string> {
  // API keys carry their org at creation time — no session lookup needed
  if (keyOrgId) return keyOrgId;
  if (sessionId) {
    const pref = await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.session_orgs WHERE session_id = ${sessionId}
    `;
    if (pref.length) return pref[0].org_id;
  }
  // No explicit session preference — always use the user's own org as the default.
  // Switching to a foreign org is done explicitly via the org switcher.
  return userId;
}

async function resolveUserOrg(userId: string, sessionId: string | null, keyOrgId?: string): Promise<string> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  return ensureTenant(orgId);
}

async function withTenant<T>(schemaName: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL search_path TO ${schemaName}, common, public`);
    return fn(tx as unknown as Sql);
  });
}

// -------------------------------------------------------
// Cache purge helpers
// -------------------------------------------------------
// After a mutation, figure out which public URLs might now be stale and
// hand the list to the CachePurger. All functions fire-and-forget: a purge
// failure must never block or fail the mutation response.
//
// Every helper is wrapped in a top-level try/catch and the caller uses
// `.catch(() => {})` so a misbehaving purger can't leak errors.

function publicUrlsForDocument(
  slug: string | null,
  collection: string,
  docId: string,
  naturalKey: string | null = null,
): string[] {
  if (!slug) return [];
  const urls = [
    // Public collection reads — authenticated or via org slug
    `/api/v1/orgs/${slug}/${collection}/${docId}`,
    `/api/v1/orgs/${slug}/${collection}/${docId}/raw`,
    `/orgs/${slug}/${collection}/${docId}`,
    `/orgs/${slug}/${collection}/${docId}/raw`,
    // Collection listings (the doc may appear in them)
    `/api/v1/orgs/${slug}/${collection}`,
    `/orgs/${slug}/${collection}`,
  ];
  // If the doc has a natural key, the /by-key/ URL variants also need
  // invalidating — without this, the addressable-by-key form would serve
  // stale content for the full cache window after a write.
  if (naturalKey) {
    const enc = encodeURIComponent(naturalKey);
    urls.push(
      `/api/v1/orgs/${slug}/${collection}/by-key/${enc}`,
      `/orgs/${slug}/${collection}/by-key/${enc}`,
    );
  }
  return urls;
}

function publicUrlsForTreePath(slug: string | null, treeName: string, treePath: string): string[] {
  if (!slug) return [];
  const clean = treePath.replace(/^\/+/, "");
  const withSlash = clean ? `/${clean}` : "";
  return [
    // The path itself — authenticated + public + short alias
    `/api/v1/orgs/${slug}/tree/${treeName}${withSlash}`,
    `/orgs/${slug}/tree/${treeName}${withSlash}`,
    // The whole-tree bundle is invalidated by any path mutation inside it
    `/api/v1/orgs/${slug}/tree/${treeName}?full=true`,
    `/orgs/${slug}/tree/${treeName}?full=true`,
    // Also the tree root listing (children array changes)
    `/api/v1/orgs/${slug}/tree/${treeName}`,
    `/orgs/${slug}/tree/${treeName}`,
  ];
}

// Queries the paths table for every tree assignment pointing at this document
// and builds purge URLs for all of them. Called after any document mutation
// that changes content (update, delete, new version, label change).
// Resolves an org's public slug. Orgs without a slug cannot have public URLs,
// so there's nothing to purge — we return null and callers short-circuit.
async function orgSlug(orgId: string): Promise<string | null> {
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM common.org_slugs WHERE org_id = ${orgId}
  `;
  return rows[0]?.slug ?? null;
}

// Called after a fresh document is created. The doc itself has no cached URL yet,
// but any listing that includes the collection is now stale.
async function purgeForCollection(orgId: string, collection: string): Promise<void> {
  try {
    const slug = await orgSlug(orgId);
    if (!slug) return;
    await cachePurger.purge([
      `/api/v1/orgs/${slug}/${collection}`,
      `/orgs/${slug}/${collection}`,
    ]);
  } catch (err) {
    console.error("[cache] purgeForCollection failed:", err);
  }
}

async function purgeForDocument(orgId: string, collection: string, docId: string): Promise<void> {
  try {
    const schemaName = sanitizeSchemaName(orgId);
    const slug = await orgSlug(orgId);

    // Look up the doc's current natural_key so we can emit the /by-key/
    // URL variants in the purge set. If the update changed the key value,
    // this purges the *new* key; the old key's cache entry expires
    // naturally within the Cache-Control max-age (60s).
    const docRows = await withTenant(schemaName, async tx =>
      tx<{ natural_key: string | null }[]>`
        SELECT natural_key FROM documents WHERE id = ${docId}
      `
    ).catch(() => [] as { natural_key: string | null }[]);
    const naturalKey = docRows[0]?.natural_key ?? null;

    const urls = new Set<string>(publicUrlsForDocument(slug, collection, docId, naturalKey));

    // Every tree path pointing at this doc also needs purging
    const treePaths = await withTenant(schemaName, async tx =>
      tx<{ tree: string; path: string }[]>`
        SELECT tree, path FROM paths WHERE document_id = ${docId}
      `
    ).catch(() => [] as { tree: string; path: string }[]);

    for (const { tree, path } of treePaths) {
      for (const u of publicUrlsForTreePath(slug, tree, path)) urls.add(u);
    }

    await cachePurger.purge([...urls]);
  } catch (err) {
    // Purge failures must never break mutations
    console.error("[cache] purgeForDocument failed:", err);
  }
}

// Called after tree PUT/DELETE — the path itself changed regardless of which
// document it now points at.
async function purgeForTreePath(orgId: string, treeName: string, treePath: string): Promise<void> {
  try {
    const slug = await orgSlug(orgId);

    const urls = new Set<string>(publicUrlsForTreePath(slug, treeName, treePath));

    // Every ancestor path is also affected (its children array changed)
    const parts = treePath.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const ancestor = "/" + parts.slice(0, i).join("/");
      for (const u of publicUrlsForTreePath(slug, treeName, ancestor === "/" ? "" : ancestor)) {
        urls.add(u);
      }
    }

    await cachePurger.purge([...urls]);
  } catch (err) {
    console.error("[cache] purgeForTreePath failed:", err);
  }
}

// -------------------------------------------------------
// Org slug helpers
// -------------------------------------------------------

const SLUG_WORDS = [
  // colours & textures
  "amber","azure","beige","brass","bronze","coral","cream","crisp","dusty","fawn",
  "gold","ivory","jade","khaki","lemon","lilac","linen","mocha","olive","pearl",
  "pine","plum","rose","rust","sage","sand","slate","smoke","steel","stone",
  "tawny","teal","umber","wheat",
  // nature — landscape
  "arch","bay","bluff","brook","canyon","cape","cave","cliff","coast","cove",
  "crag","creek","dale","dell","dune","fell","fen","fjord","ford","glen",
  "gorge","gulf","heath","hill","isle","knoll","lake","ledge","loch","mead",
  "mesa","moor","peak","pond","pool","reef","ridge","rise","shoal","slope",
  "sound","spur","vale","vault","wold",
  // nature — flora & fauna
  "ash","birch","cedar","elm","fern","fir","fox","hawk","heron","iris",
  "jay","kite","lark","lynx","moth","oak","otter","owl","rook","rook",
  "rush","seal","swan","thorn","vine","wren","yew",
  // qualities & moods
  "bold","brave","bright","brisk","calm","clear","cool","crisp","deft","deep",
  "fair","fast","fierce","firm","fleet","free","keen","kind","lean","light",
  "lone","mild","neat","noble","pure","quick","quiet","rare","sharp","slim",
  "soft","still","swift","tall","tame","true","warm","wild","wise","young",
  // elements & materials
  "ash","bark","beam","brine","clay","coal","crest","dew","drift","dust",
  "ember","flint","foam","frost","gale","glow","haze","husk","mist","moss",
  "mud","ore","peat","rime","salt","silt","snow","soil","steam","tide",
  "wave","wind",
];

function randomSlug(): string {
  const pick = () => SLUG_WORDS[Math.floor(Math.random() * SLUG_WORDS.length)]!;
  return `${pick()}-${pick()}-${pick()}`;
}

async function getOrCreateSlug(orgId: string, _email: string): Promise<string> {
  // Return existing slug if already assigned
  const existing = await sql<{ slug: string }[]>`
    SELECT slug FROM common.org_slugs WHERE org_id = ${orgId}
  `;
  if (existing.length) return existing[0].slug!;

  // Generate a unique 3-word slug
  let candidate = randomSlug();
  let attempts = 0;
  while (attempts < 20) {
    const conflict = await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.org_slugs WHERE slug = ${candidate}
    `;
    if (!conflict.length) break;
    candidate = randomSlug();
    attempts++;
  }

  // Race-safe insert — if another request won the race, re-select
  await sql`
    INSERT INTO common.org_slugs (org_id, slug)
    VALUES (${orgId}, ${candidate})
    ON CONFLICT DO NOTHING
  `;
  const row = await sql<{ slug: string }[]>`
    SELECT slug FROM common.org_slugs WHERE org_id = ${orgId}
  `;
  return row[0]?.slug ?? candidate;
}

async function setSlug(orgId: string, slug: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new Error("Invalid slug: must be 3-40 lowercase alphanumeric characters or hyphens, no leading/trailing hyphens");
  }
  await sql`
    INSERT INTO common.org_slugs (org_id, slug, updated_at)
    VALUES (${orgId}, ${slug}, NOW())
    ON CONFLICT (org_id) DO UPDATE SET slug = ${slug}, updated_at = NOW()
  `;
}

// -------------------------------------------------------
// CORS
// -------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "http://localhost:4000",
  "http://localhost:4001",
  "http://localhost:4002",
  ...(process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL.replace(/\/$/, "")] : []),
  ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map(s => s.trim().replace(/\/$/, ""))
    : []),
]);

function corsHeaders(origin: string | null, host: string | null): Record<string, string> {
  let allowed = "";
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    allowed = origin;
  } else if (origin && host) {
    // Same-site: if the Origin's host matches the request Host header, always allow.
    // This covers Cloudflare Tunnel and any reverse proxy without needing env vars.
    try { if (new URL(origin).host === host) allowed = origin; } catch {}
  }
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Cookie",
  };
}

// -------------------------------------------------------
// Auth helpers
// -------------------------------------------------------

// -------------------------------------------------------
// API key helpers
// -------------------------------------------------------

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "wren_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "inv_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

type SessionUser = { userId: string; name: string; email: string; sessionId: string | null; keyId?: string; keyOrgId?: string };

async function checkApiKey(req: Request): Promise<SessionUser | null> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer wren_")) return null;
  const token = header.slice(7);
  const hash = await sha256hex(token);
  const rows = await sql<{ id: string; user_id: string; org_id: string; expires_at: Date | null }[]>`
    SELECT id, user_id, org_id, expires_at FROM common.api_keys
    WHERE key_hash = ${hash} AND revoked_at IS NULL
  `;
  if (!rows.length) return null;
  const key = rows[0];
  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;
  sql`UPDATE common.api_keys SET last_used_at = NOW() WHERE key_hash = ${hash}`.catch(() => {});
  const users = await sql<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email FROM "user" WHERE id = ${key.user_id}
  `;
  if (!users.length) return null;
  return { userId: users[0].id, name: users[0].name, email: users[0].email, sessionId: null, keyId: key.id, keyOrgId: key.org_id };
}

async function requireSession(req: Request): Promise<SessionUser | null> {
  const apiKey = await checkApiKey(req);
  if (apiKey) return apiKey;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name, email: session.user.email, sessionId: session.session.id };
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// -------------------------------------------------------
// Access control
// -------------------------------------------------------

type AccessResult = {
  allowed: boolean;
  access?: string;
  labelFilter?: string;
  filterLang?: string;
  filterExpr?: string;
  auditReads: boolean;
  auditWrites: boolean;
  permissionId?: string;
};

const ACCESS_LEVELS: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3 };

function principalFor(user: SessionUser): string {
  return user.keyId ? `key:${user.keyId}` : `member:${user.userId}`;
}

async function checkAccess(
  orgId: string,
  userId: string,
  principal: string,
  resource: string,
  requiredAccess: "read" | "write" | "admin",
): Promise<AccessResult> {
  // Org owners bypass all permission checks
  if (userId === orgId) {
    return { allowed: true, auditReads: false, auditWrites: false };
  }

  const [type] = resource.split(":");
  const categoryWild = `${type}:*`;

  // Query the most-specific matching permission rule
  const rows = await sql<{
    id: string; access: string;
    label_filter: string | null;
    filter_lang: string | null;
    filter_expr: string | null;
    audit_reads: boolean;
    audit_writes: boolean;
    resource: string;
  }[]>`
    SELECT id, access, label_filter, filter_lang, filter_expr, audit_reads, audit_writes, resource
    FROM common.permissions
    WHERE org_id = ${orgId}
      AND principal = ${principal}
      AND resource = ANY(ARRAY[${resource}, ${categoryWild}, '*'])
    ORDER BY CASE resource
        WHEN ${resource}      THEN 0
        WHEN ${categoryWild}  THEN 1
        ELSE 2
      END
    LIMIT 1
  `;

  if (!rows.length) {
    // No matching rule → deny by default
    return { allowed: false, auditReads: false, auditWrites: false };
  }

  const rule = rows[0];
  const ruleLevel = ACCESS_LEVELS[rule.access] ?? 0;
  const requiredLevel = ACCESS_LEVELS[requiredAccess] ?? 1;

  if (ruleLevel === 0 || ruleLevel < requiredLevel) {
    return {
      allowed: false,
      access: rule.access,
      auditReads: rule.audit_reads,
      auditWrites: rule.audit_writes,
      permissionId: rule.id,
    };
  }

  return {
    allowed: true,
    access: rule.access,
    labelFilter: rule.label_filter ?? undefined,
    filterLang: rule.filter_lang ?? undefined,
    filterExpr: rule.filter_expr ?? undefined,
    auditReads: rule.audit_reads,
    auditWrites: rule.audit_writes,
    permissionId: rule.id,
  };
}

function logAccess(
  orgId: string,
  principal: string,
  resource: string,
  method: string,
  path: string,
  status: number,
): void {
  sql`
    INSERT INTO common.access_log (org_id, principal, resource, method, path, status)
    VALUES (${orgId}, ${principal}, ${resource}, ${method}, ${path}, ${status})
  `.catch(() => {});
}

async function applyDataFilter(data: unknown, lang: string, expr: string): Promise<unknown> {
  try {
    if (lang === "jq") {
      return await jqJson(data, expr);
    }
    if (lang === "jmespath") {
      return jmespath.search(data, expr);
    }
    if (lang === "jsonata") {
      return await jsonata(expr).evaluate(data);
    }
  } catch {
    return null;
  }
  return data;
}

// -------------------------------------------------------
// Server
// -------------------------------------------------------

const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 4000,

  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin, req.headers.get("host"));

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // HEAD is routed exactly like GET — every handler that answers GET
    // should also answer HEAD with the same headers (and status) but an
    // empty body. We rewrite to GET on the way in, then strip the body
    // (and any auto-set Content-Length conflict) on the way out.
    const isHead = req.method === "HEAD";
    const effectiveReq = isHead
      ? new Request(req.url, { method: "GET", headers: req.headers })
      : req;

    let res = await handleRequest(effectiveReq, url);
    if (isHead) {
      // Per RFC 7231: HEAD returns the same headers as GET but no body.
      // Preserve the Content-Length the GET response would have reported
      // by reading the body first and using its byte length as the
      // Content-Length header, then constructing an empty-body response.
      const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
      const headers = new Headers(res.headers);
      if (!headers.has("content-length")) {
        headers.set("content-length", String(body.byteLength));
      }
      res = new Response(null, { status: res.status, headers });
    }

    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  },
});

async function handleRequest(req: Request, url: URL): Promise<Response> {

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.4.2", build: "20260414b" });
    }


    // WREN logo — served from public directory (no auth required)
    if (url.pathname === "/wren-logo.svg") {
      return new Response(Bun.file(join(import.meta.dir, "public", "wren-logo.svg")), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
      });
    }

    // Favicons — the SVG is the authoritative source; /favicon.ico is
    // aliased to the same file so browsers that blindly request it
    // (Firefox, curl probing, etc.) don't get a 404 in every access log.
    // Modern browsers prefer the <link rel="icon" type="image/svg+xml">
    // declared in each HTML page, which points directly at /favicon.svg.
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(Bun.file(join(import.meta.dir, "public", "wren-logo.svg")), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // PWA / "add to home screen" manifest. Used for tab theming on mobile,
    // app icons, and the standalone-display launcher state.
    if (url.pathname === "/site.webmanifest" || url.pathname === "/manifest.json") {
      return new Response(Bun.file(join(import.meta.dir, "public", "site.webmanifest")), {
        headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Marketing site — root now serves variant C (three building blocks).
    // Variant A is still accessible at /a for the A/B/C experiment.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "combined.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // A/B variant A — original document-focused landing
    if (url.pathname === "/a" || url.pathname === "/a.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "index.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "styles.css")), {
        headers: { "Content-Type": "text/css" },
      });
    }
    if (url.pathname === "/tutorial" || url.pathname === "/tutorial.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "tutorial.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // A/B variant B — tree-focused landing
    if (url.pathname === "/b" || url.pathname === "/b.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "trees.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // A/B variant C — three-primitives combined landing
    if (url.pathname === "/c" || url.pathname === "/c.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "combined.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // Tree-focused tutorial
    if (url.pathname === "/tutorial/trees" || url.pathname === "/tutorial/trees.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "tutorial-trees.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // Deploy-focused tutorial
    if (url.pathname === "/tutorial/deploy" || url.pathname === "/tutorial/deploy.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "tutorial-deploy.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // A/B variant D — deploy-focused landing
    if (url.pathname === "/d" || url.pathname === "/d.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "deploy.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // Projects directory — lists all orgs with public permissions
    if (url.pathname === "/projects" || url.pathname === "/projects.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "projects.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }

    // LLM / crawler discovery files
    if (url.pathname === "/robots.txt") {
      const base = `${url.protocol}//${url.host}`;
      return new Response(
        `User-agent: *\nAllow: /\n\n# AI crawlers — welcome\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: anthropic-ai\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    if (url.pathname === "/sitemap.xml") {
      const base = `${url.protocol}//${url.host}`;
      const now = new Date().toISOString().split("T")[0];
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${base}/</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/a</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/b</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/c</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/tutorial</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/tutorial/trees</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/tutorial/deploy</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/d</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/docs</loc><lastmod>${now}</lastmod><priority>0.8</priority></url>\n  <url><loc>${base}/projects</loc><lastmod>${now}</lastmod><priority>0.8</priority></url>\n  <url><loc>${base}/llms.txt</loc><lastmod>${now}</lastmod><priority>0.7</priority></url>\n</urlset>`,
        { headers: { "Content-Type": "application/xml; charset=utf-8" } },
      );
    }
    if (url.pathname === "/llms.txt") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "llms.txt")), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/llms-full.txt") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "llms-full.txt")), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/img/")) {
      const imgFile = Bun.file(join(import.meta.dir, "public", "marketing", url.pathname));
      if (await imgFile.exists()) {
        const ext = url.pathname.split(".").pop() ?? "";
        const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
        return new Response(imgFile, { headers: { "Content-Type": mime[ext] ?? "application/octet-stream" } });
      }
    }

    // Plain-JS admin UI — served directly from public/admin/ (no build step)
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const subPath = url.pathname.slice("/admin".length);
      const filePath = (!subPath || subPath === "/")
        ? ADMIN_INDEX
        : join(ADMIN_DIR, subPath);
      return serveAdminFile(filePath) ?? serveAdminIndex();
    }

    // Legacy React admin UI — built static files with SPA fallback
    if (url.pathname === "/oldadmin" || url.pathname.startsWith("/oldadmin/")) {
      const subPath = url.pathname.slice("/oldadmin".length);
      const filePath = (!subPath || subPath === "/")
        ? OLDADMIN_INDEX
        : join(OLDADMIN_DIR, subPath);
      return serveOldAdminFile(filePath) ?? serveOldAdminIndex();
    }

    // Auth routes — handled by Better Auth
    // Cloudflare Tunnel (and other reverse proxies) terminate TLS and forward
    // plain HTTP. Better Auth auto-detects its origin from the request URL, so
    // it sees http:// while the browser sends Origin: https://. Rewrite the
    // request URL to match the real protocol so origin validation succeeds.
    if (url.pathname.startsWith("/api/auth")) {
      const proto = req.headers.get("x-forwarded-proto");
      if (proto === "https" && !req.url.startsWith("https://")) {
        const secureUrl = req.url.replace(/^http:/, "https:");
        return auth.handler(new Request(secureUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          // @ts-ignore — Bun supports duplex
          duplex: "half",
        }));
      }
      return auth.handler(req);
    }

    // Login UI
    if (url.pathname === "/login") {
      return new Response(Bun.file("public/auth.html"));
    }

    // Profile — protected route
    if (url.pathname === "/profile") {
      const isApiRequest = req.headers.get("accept")?.includes("application/json");
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) {
        if (isApiRequest) return Response.json({ error: "Unauthorized" }, { status: 401 });
        return Response.redirect(`/login?redirect=/profile`, 302);
      }
      if (isApiRequest) return Response.json({ user: session.user });
      return new Response(Bun.file("public/profile.html"));
    }

    // OpenAPI spec
    if (url.pathname === "/openapi.json") {
      return Response.json(openapiJson);
    }

    // Scalar API docs — with the common marketing nav at the top
    if (url.pathname === "/docs") {
      return new Response(
        `<!doctype html>
<html>
  <head>
    <title>WREN API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="alternate icon" href="/favicon.ico" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#4338ca" />
    <link rel="stylesheet" href="/styles.css" />
    <style>
      .docs-body { padding-top: var(--nav-height); }
    </style>
  </head>
  <body>
    <nav class="nav">
      <div class="nav__inner">
        <a href="/" class="nav__logo"><img src="/wren-logo.svg" alt="WREN" class="nav__logo-img" />WREN</a>
        <ul class="nav__links">
          <li><a href="/tutorial">Tutorial</a></li>
          <li><a href="/docs" style="color:var(--color-primary);font-weight:600">Docs</a></li>
          <li><a href="/#clients">Libraries</a></li>
          <li><a href="/#pricing">Pricing</a></li>
          <li><a href="/projects">Projects</a></li>
          <li><a href="/admin">Admin</a></li>
        </ul><button class="nav__hamburger" onclick="document.querySelector('.nav__links').classList.toggle('open')" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg></button>
      </div>
    </nav>
    <div class="docs-body">
      <script id="api-reference" data-url="/openapi.json"></script>
      <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    </div>
  </body>
</html>`,
        { headers: { "Content-Type": "text/html", ...NO_CACHE } }
      );
    }

    // Well-known llms.txt — /.well-known/llms.txt
    if (req.method === "GET" && url.pathname === "/.well-known/llms.txt") {
      return handleWellKnownLlmsTxt(url);
    }

    // Clean public URLs: /orgs/{slug}/... — alias for /api/v1/orgs/{slug}/...
    // Allows tree paths like /orgs/tkd/tree/site/index.html to open directly in a browser.
    if (req.method === "GET" && url.pathname.startsWith("/orgs/")) {
      const parts = url.pathname.slice("/orgs/".length).split("/");
      const [slug, ...rest] = parts;
      if (slug && rest.length > 0) {
        const sub = rest[0];
        if (sub === "llms.txt") {
          const optionalUser = await requireSession(req);
          return handleOrgLlmsTxt(slug, url, optionalUser);
        }
        // Pass everything after /orgs/{slug}/ to the public collection/tree handler
        const collection = rest[0];
        const id = rest[1];
        const subSeg = rest[2];
        return handlePublicCollectionRequest(slug, collection, id, subSeg, url, req.headers.get("accept"));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // All data/management API routes live under /api/v1/
    if (!url.pathname.startsWith("/api/v1/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Strip /api/v1 prefix and re-parse segments for API routing
    const apiPath = url.pathname.slice(7); // removes "/api/v1"
    const segments = apiPath.replace(/^\//, "").split("/");
    const [collection, id, sub, version, subsub] = segments;

    // /api/v1/projects — public, no auth: list all orgs with principal='*' permissions
    if (collection === "projects" && !id && req.method === "GET") {
      return handleListProjects(url);
    }

    // /api/v1/orgs/{slug}/... — context-aware: auth optional
    // llms.txt: serves public context if no session, full context if authenticated
    // collection routes: public access gated by principal='*' permission rules
    if (collection === "orgs" && id) {
      if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
      const optionalUser = await requireSession(req); // null = unauthenticated
      if (sub === "llms.txt") return handleOrgLlmsTxt(id, url, optionalUser);
      if (sub) return handlePublicCollectionRequest(id, sub, version, subsub, url, req.headers.get("accept"));
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // All other routes require authentication
    const user = await requireSession(req);
    if (!user) return unauthorized();

    // Identity & scope — /api/v1/me
    if (collection === "me" && !id) {
      if (req.method === "GET") return handleGetMe(user);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // API key management routes — /api/v1/keys[/:keyId]
    if (collection === "keys") {
      if (req.method === "GET"    && !id)   return handleListApiKeys(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && !id)   return handleCreateApiKey(req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "DELETE" && id)    return handleRevokeApiKey(id, user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Org context routes — /api/v1/org and /api/v1/org/slug
    if (collection === "org" && !id) {
      if (req.method === "GET") return handleGetOrg(user.userId, user.sessionId);
      if (req.method === "PUT") return handleSwitchOrg(req, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (collection === "org" && id === "slug" && !sub) {
      if (req.method === "PUT") return handleSetOrgSlug(req, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (collection === "org" && id === "usage" && !sub) {
      if (req.method === "GET") return handleGetOrgUsage(user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Invite management routes — /api/v1/invites[/:inviteId | /accept | /received]
    if (collection === "invites") {
      if (req.method === "GET"    && !id)               return handleListInvites(user.userId, user.sessionId);
      if (req.method === "GET"    && id === "received")  return handleListReceivedInvites(user);
      if (req.method === "POST"   && !id)               return handleCreateInvite(req, user.userId, user.sessionId);
      if (req.method === "POST"   && id === "accept")   return handleAcceptInvite(req, user.userId);
      if (req.method === "POST"   && sub === "accept")  return handleAcceptInviteById(id, user);
      if (req.method === "DELETE" && id)                return handleRevokeInvite(id, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Member management routes — /api/v1/members[/:memberId]
    if (collection === "members") {
      if (req.method === "GET"    && !id) return handleListMembers(user.userId, user.sessionId);
      if (req.method === "DELETE" && id)  return handleRemoveMember(id, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Permission management routes — /api/v1/permissions[/:permissionId]
    if (collection === "permissions") {
      if (req.method === "GET"    && !id)  return handleListPermissions(user.userId, user.sessionId);
      if (req.method === "POST"   && !id)  return handleCreatePermission(req, user.userId, user.sessionId);
      if (req.method === "PUT"    && id)   return handleUpdatePermission(id, req, user.userId, user.sessionId);
      if (req.method === "DELETE" && id)   return handleDeletePermission(id, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Resolve org — split into orgId + schemaName so access checks can use orgId
    const orgId = await resolveUserOrgId(user.userId, user.sessionId, user.keyOrgId);
    const schemaName = await ensureTenant(orgId);
    const principal = principalFor(user);

    // Helper: check access and return 403 on denial (fires audit log on deny)
    async function gate(resource: string, reqAccess: "read" | "write" | "admin"): Promise<AccessResult | Response> {
      const ar = await checkAccess(orgId, user.userId, principal, resource, reqAccess);
      if (!ar.allowed) {
        const shouldLog = reqAccess === "read" ? ar.auditReads : ar.auditWrites;
        if (shouldLog) logAccess(orgId, principal, resource, req.method, url.pathname, 403);
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      return ar;
    }

    // Helper: audit a successful response if the rule asks for it
    function audit(ar: AccessResult, resource: string, isRead: boolean, status: number) {
      const shouldLog = isRead ? ar.auditReads : ar.auditWrites;
      if (shouldLog) logAccess(orgId, principal, resource, req.method, url.pathname, status);
    }

    // Helper: apply per-permission data filter to document data field(s) in a response
    async function filterResponse(res: Response, ar: AccessResult): Promise<Response> {
      if (!ar.filterExpr || !ar.filterLang) return res;
      const body = await res.json() as Record<string, unknown>;
      if (Array.isArray(body.items)) {
        body.items = await Promise.all(
          (body.items as { data: unknown }[]).map(async item => ({
            ...item,
            data: await applyDataFilter(item.data, ar.filterLang!, ar.filterExpr!),
          }))
        );
      } else if ("data" in body) {
        body.data = await applyDataFilter(body.data, ar.filterLang!, ar.filterExpr!);
      }
      return Response.json(body, { status: res.status });
    }

    // Route: GET /collections — list distinct collection names
    if (req.method === "GET" && collection === "collections" && !id) {
      return handleListCollections(schemaName);
    }

    // Tree routes: GET|PUT|DELETE /tree/{treeName}/{...path}
    // Also: GET /tree — list all tree names
    if (collection === "tree") {
      if (req.method === "GET" && !id) return handleListTrees(schemaName);
      const treeName = id; // second segment is the tree name
      const treePath = "/" + segments.slice(2).join("/");
      if (!treeName) return Response.json({ error: "Tree name required" }, { status: 400 });
      const treeResource = `tree:${treeName}`;
      const treeIsRead = req.method === "GET";
      const treeAr = await gate(treeResource, treeIsRead ? "read" : "write");
      if (treeAr instanceof Response) return treeAr;
      trackRequest(orgId, treeIsRead);
      let treeRes: Response;
      const effectiveTreeLabel = treeAr.labelFilter ?? url.searchParams.get("label") ?? undefined;
      if (req.method === "GET" && url.searchParams.get("full") === "true")
        treeRes = await handleTreeFull(schemaName, treeName, effectiveTreeLabel);
      else if (req.method === "GET")
        treeRes = await handleTreeGet(schemaName, treeName, treePath, req.headers.get("accept"), effectiveTreeLabel);
      else if (req.method === "PUT") {
        treeRes = await handleTreePut(schemaName, treeName, treePath, req, user.userId, orgId);
        if (treeRes.status < 400) {
          purgeForTreePath(orgId, treeName, treePath).catch(() => {});
        }
      }
      else if (req.method === "DELETE") {
        treeRes = await handleTreeDelete(schemaName, treeName, treePath, user.userId);
        if (treeRes.status < 400) {
          purgeForTreePath(orgId, treeName, treePath).catch(() => {});
        }
      }
      else return Response.json({ error: "Method not allowed" }, { status: 405 });
      audit(treeAr, treeResource, treeIsRead, treeRes.status);
      return treeIsRead ? filterResponse(treeRes, treeAr) : treeRes;
    }

    // All remaining routes are collection-scoped
    const colResource = `collection:${collection}`;

    // Determine required access level from method + sub-route
    let reqAccess: "read" | "write" | "admin" = "read";
    if (id === "_schema" && sub === "validate") {
      // Dry-run validation is read-only — it never mutates the schema or docs
      reqAccess = "read";
    } else if (id === "_schema" && req.method !== "GET") {
      reqAccess = "admin";
    } else if (id === "by-key") {
      // Natural-key routes: GET is read, PUT/DELETE are write. They
      // ultimately call the same write path as /{collection}/{id} so the
      // access level must match.
      reqAccess = req.method === "GET" ? "read" : "write";
    } else if (req.method !== "GET") {
      reqAccess = "write";
    }

    const colAr = await gate(colResource, reqAccess);
    if (colAr instanceof Response) return colAr;

    const colIsRead = reqAccess === "read";
    trackRequest(orgId, colIsRead);

    // Route: GET /{collection}
    if (req.method === "GET" && !id) {
      const res = await handleList(schemaName, collection, url, user.userId, colAr.labelFilter);
      audit(colAr, colResource, true, res.status);
      return filterResponse(res, colAr);
    }

    // Schema routes: GET|PUT|DELETE /{collection}/_schema
    if (id === "_schema" && !sub) {
      if (req.method === "GET")    { const r = await handleGetSchema(schemaName, collection);    audit(colAr, colResource, true, r.status);  return r; }
      if (req.method === "PUT")    { const r = await handleSetSchema(schemaName, collection, req, user.userId); audit(colAr, colResource, false, r.status); return r; }
      if (req.method === "DELETE") { const r = await handleDeleteSchema(schemaName, collection); audit(colAr, colResource, false, r.status); return r; }
    }

    // Dry-run schema validation: GET|POST /{collection}/_schema/validate
    // Read-only — runs the current or a proposed schema against every existing
    // document and reports which ones would fail, without touching anything.
    if (id === "_schema" && sub === "validate") {
      if (req.method === "GET" || req.method === "POST") {
        const r = await handleValidateSchema(schemaName, collection, req, url);
        audit(colAr, colResource, true, r.status);
        return r;
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Natural-key routes: GET|PUT|DELETE /{collection}/by-key/{keyValue}
    // Upsert-by-key is the headline — a single transactional call replaces
    // the list-then-find-then-put idiom that every ingestion client
    // otherwise reinvents.
    if (id === "by-key" && sub) {
      const keyValue = decodeURIComponent(sub);
      if (req.method === "GET") {
        const effectiveLabel = colAr.labelFilter ?? url.searchParams.get("label") ?? undefined;
        const effectiveUrl = effectiveLabel
          ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
          : url;
        const r = await handleGetByKey(schemaName, collection, keyValue, effectiveUrl);
        audit(colAr, colResource, true, r.status);
        return filterResponse(r, colAr);
      }
      if (req.method === "PUT") {
        const { res, id: docId } = await handleUpsertByKey(schemaName, collection, keyValue, req, user.userId);
        audit(colAr, colResource, false, res.status);
        if (res.status < 400 && docId) {
          purgeForDocument(orgId, collection, docId).catch(() => {});
        }
        return res;
      }
      if (req.method === "DELETE") {
        const { res, id: docId } = await handleDeleteByKey(schemaName, collection, keyValue);
        audit(colAr, colResource, false, res.status);
        if (res.status < 400 && docId) {
          purgeForDocument(orgId, collection, docId).catch(() => {});
        }
        return res;
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Route: GET /{collection}/{id}/raw  (binary asset download)
    if (req.method === "GET" && id && sub === "raw") {
      const r = await handleGetAssetRaw(schemaName, collection, id, url);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Route: GET /{collection}/{id}
    if (req.method === "GET" && id && !sub) {
      // If permission has a label filter, use it (overrides explicit ?label= only if not set by user)
      const effectiveLabel = colAr.labelFilter ?? url.searchParams.get("label") ?? undefined;
      const effectiveUrl = effectiveLabel
        ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
        : url;
      const r = await handleGet(schemaName, collection, id, effectiveUrl);
      audit(colAr, colResource, true, r.status);
      return filterResponse(r, colAr);
    }

    // Route: POST /{collection}  — multipart = binary upload, JSON = document
    if (req.method === "POST" && !id) {
      const ct = req.headers.get("content-type") ?? "";
      const r = ct.startsWith("multipart/form-data")
        ? await handleCreateAsset(schemaName, collection, req, user.userId)
        : await handleCreate(schemaName, collection, req, user.userId);
      audit(colAr, colResource, false, r.status);
      // Fresh create → new URL, nothing cached yet, but purge the collection
      // list URLs since the doc appears in them.
      if (r.status < 400) {
        purgeForCollection(orgId, collection).catch(() => {});
      }
      return r;
    }

    // Route: PUT /{collection}/{id}  — multipart = new binary version, JSON = document update
    if (req.method === "PUT" && id && !sub) {
      const ct = req.headers.get("content-type") ?? "";
      const r = ct.startsWith("multipart/form-data")
        ? await handleUpdateAsset(schemaName, collection, id, req, user.userId)
        : await handleUpdate(schemaName, collection, id, req, user.userId);
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
      }
      return r;
    }

    // Route: DELETE /{collection}/{id}
    if (req.method === "DELETE" && id && !sub) {
      const r = await handleDelete(schemaName, collection, id);
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
      }
      return r;
    }

    // Route: GET /{collection}/{id}/paths
    if (req.method === "GET" && id && sub === "paths" && !version) {
      const r = await handleDocumentPaths(schemaName, collection, id);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Route: GET /{collection}/{id}/versions
    if (req.method === "GET" && id && sub === "versions" && !version) {
      const r = await handleVersionList(schemaName, collection, id);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Route: GET /{collection}/{id}/versions/{v}
    if (req.method === "GET" && id && sub === "versions" && version) {
      const r = await handleVersionGet(schemaName, collection, id, version);
      audit(colAr, colResource, true, r.status);
      return filterResponse(r, colAr);
    }

    // Route: POST /{collection}/{id}/rollback/{v}
    if (req.method === "POST" && id && sub === "rollback" && version) {
      const r = await handleRollback(schemaName, collection, id, version, user.userId);
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
      }
      return r;
    }

    // Route: POST /{collection}/{id}/labels
    if (req.method === "POST" && id && sub === "labels") {
      const r = await handleLabel(schemaName, collection, id, req, user.userId);
      audit(colAr, colResource, false, r.status);
      // Label changes affect ?label=foo responses
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
      }
      return r;
    }

    // Route: GET /{collection}/{id}/diff
    if (req.method === "GET" && id && sub === "diff") {
      const r = await handleDiff(schemaName, collection, id, url);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    return Response.json({ error: "Not found" }, { status: 404 });
}

// -------------------------------------------------------
// Handlers
// -------------------------------------------------------

async function handleList(
  schemaName: string,
  collection: string,
  url: URL,
  _userId: string,
  labelFilter?: string,
): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  // ?label= on the URL takes precedence over the permission label filter
  const effectiveLabel = url.searchParams.get("label") ?? labelFilter;

  const [items, [{ total }]] = await withTenant(schemaName, async tx => {
    let rows: { id: string; version: number; data: unknown; created_at: Date; updated_at: Date; labels: string[] }[];
    if (effectiveLabel) {
      // Only return documents that carry this label, at the labelled version
      rows = await tx<typeof rows>`
        SELECT d.id, lf.version, v.data, d.created_at, d.updated_at,
               COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
        FROM documents d
        JOIN labels lf ON lf.document_id = d.id AND lf.label = ${effectiveLabel}
        JOIN versions v ON v.document_id = d.id AND v.version = lf.version
        LEFT JOIN labels l ON l.document_id = d.id
        WHERE d.collection = ${collection} AND d.deleted_at IS NULL
        GROUP BY d.id, lf.version, v.data, d.created_at, d.updated_at
        ORDER BY d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await tx<typeof rows>`
        SELECT d.id, d.current_version AS version, v.data, d.created_at, d.updated_at,
               COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
        FROM documents d
        JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
        LEFT JOIN labels l ON l.document_id = d.id
        WHERE d.collection = ${collection} AND d.deleted_at IS NULL
        GROUP BY d.id, d.current_version, v.data, d.created_at, d.updated_at
        ORDER BY d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
    const count = effectiveLabel
      ? await tx<{ total: string }[]>`
          SELECT COUNT(*)::text AS total
          FROM documents d
          JOIN labels lf ON lf.document_id = d.id AND lf.label = ${effectiveLabel}
          WHERE d.collection = ${collection} AND d.deleted_at IS NULL
        `
      : await tx<{ total: string }[]>`
          SELECT COUNT(*)::text AS total FROM documents
          WHERE collection = ${collection} AND deleted_at IS NULL
        `;
    return [rows, count];
  });

  return Response.json({
    collection,
    items: items.map(r => ({ id: r.id, version: r.version, data: r.data, createdAt: r.created_at, updatedAt: r.updated_at, labels: r.labels })),
    total: parseInt(total),
  });
}

async function getCollectionType(schemaName: string, collection: string): Promise<"json" | "binary"> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection_type: string }[]>`
      SELECT collection_type FROM collection_schemas WHERE collection = ${collection}
    `
  );
  return (rows[0]?.collection_type === "binary") ? "binary" : "json";
}

async function validateAgainstSchema(schemaName: string, collection: string, data: unknown): Promise<string[] | null> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ schema: unknown; collection_type: string }[]>`
      SELECT schema, collection_type FROM collection_schemas WHERE collection = ${collection}
    `
  );
  if (rows.length === 0) return null;
  if (rows[0].collection_type === "binary") return null; // binary collections skip JSON validation
  const validate = ajv.compile(rows[0].schema as object);
  if (validate(data)) return null;
  return (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message}`);
}

// ── Natural key helpers ──────────────────────────────────────────────────────
//
// Collections can designate a single top-level field of their document data
// as a natural key (e.g. "slug"). The value is extracted on write and stored
// in the `documents.natural_key` column, which is uniquely indexed per
// collection. This lets callers address documents via /by-key/{value}
// and implement upsert-by-key in a single transactional call.
//
// A tiny per-schema cache avoids a DB round trip on every write. Entries are
// invalidated whenever handleSetSchema runs.

const naturalKeyCache = new Map<string, { field: string | null; fetchedAt: number }>();
const NATURAL_KEY_CACHE_TTL_MS = 60_000;

async function getNaturalKeyField(schemaName: string, collection: string): Promise<string | null> {
  const cacheKey = `${schemaName}:${collection}`;
  const cached = naturalKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NATURAL_KEY_CACHE_TTL_MS) {
    return cached.field;
  }
  const rows = await withTenant(schemaName, async tx =>
    tx<{ natural_key: string | null }[]>`
      SELECT natural_key FROM collection_schemas WHERE collection = ${collection}
    `
  );
  const field = rows[0]?.natural_key ?? null;
  naturalKeyCache.set(cacheKey, { field, fetchedAt: Date.now() });
  return field;
}

// Pulls the natural-key value out of the incoming document data. Returns null
// when: no key is configured, the field is missing, the value is nullish,
// the value is a non-string, or the trimmed value is empty. Non-null return
// means "this doc has a usable key value that should be persisted to
// documents.natural_key".
async function extractNaturalKey(
  schemaName: string,
  collection: string,
  data: unknown,
): Promise<string | null> {
  const field = await getNaturalKeyField(schemaName, collection);
  if (!field) return null;
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

// Classifies a Postgres error to detect the natural-key unique violation.
// Postgres error code 23505 is unique_violation; we further narrow by
// constraint name so we don't misreport unrelated unique conflicts.
function isNaturalKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint_name?: string; constraint?: string };
  return e.code === "23505" &&
    (e.constraint_name === "documents_natural_key_unique_idx" ||
     e.constraint === "documents_natural_key_unique_idx");
}

// Dry-run validation — runs the current or a proposed schema against every
// existing document in a collection and returns which ones would fail.
// Never mutates anything. Intended for "what happens if I tighten this schema"
// before actually setting it.
//
// Accepts an optional schema in the request body (POST). If no body is present,
// the currently-stored schema is used. Caps the number of documents checked
// and the number of failure details returned so a single call is bounded
// regardless of collection size.
async function handleValidateSchema(schemaName: string, collection: string, req: Request, url: URL): Promise<Response> {
  // Optional proposed schema from the request body
  let proposedSchema: unknown = undefined;
  if (req.method === "POST") {
    try {
      const body = await req.json() as unknown;
      if (body && typeof body === "object") {
        // Wrapper form: { "schema": {...} } — matches handleSetSchema
        if ("schema" in body) {
          proposedSchema = (body as { schema: unknown }).schema;
        } else {
          // Plain form: the whole body is the JSON Schema
          proposedSchema = body;
        }
      }
    } catch {
      // No body or invalid JSON → fall through to stored schema
    }
  }

  // Resolve the schema to validate against
  let schemaToUse: unknown;
  let schemaSource: "current" | "proposed";
  if (proposedSchema !== undefined) {
    schemaToUse = proposedSchema;
    schemaSource = "proposed";
  } else {
    const rows = await withTenant(schemaName, async tx =>
      tx<{ schema: unknown; collection_type: string }[]>`
        SELECT schema, collection_type FROM collection_schemas WHERE collection = ${collection}
      `
    );
    if (rows.length === 0) {
      return Response.json({
        error: "No schema set for this collection",
        hint: "Set a schema first via PUT /api/v1/{collection}/_schema, or POST a proposed schema in the body of this request to dry-run against existing documents.",
      }, { status: 404 });
    }
    if (rows[0].collection_type === "binary") {
      return Response.json({
        error: "Binary collections do not use JSON Schema validation",
      }, { status: 400 });
    }
    schemaToUse = rows[0].schema;
    schemaSource = "current";
  }

  // Compile the validator — also sanity-checks the schema itself
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schemaToUse as object);
  } catch (e) {
    return Response.json({
      error: "Invalid JSON Schema",
      details: String(e),
    }, { status: 422 });
  }

  // Pagination caps
  const maxDocs = Math.min(
    Math.max(parseInt(url.searchParams.get("max") ?? "10000") || 10000, 1),
    50000,
  );
  const failureLimit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "100") || 100, 1),
    1000,
  );

  // Fetch up to maxDocs documents at their current version
  const docs = await withTenant(schemaName, async tx =>
    tx<{ id: string; version: number; data: unknown }[]>`
      SELECT d.id, d.current_version AS version, v.data
      FROM documents d
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.collection = ${collection} AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC
      LIMIT ${maxDocs}
    `
  );

  // Run the validator over each document. Errors live on validate.errors
  // after each call and are overwritten on the next call, so capture
  // them immediately into the failures array.
  let validCount = 0;
  let invalidCount = 0;
  const failures: Array<{ id: string; version: number; errors: string[] }> = [];

  for (const doc of docs) {
    if (validate(doc.data)) {
      validCount++;
    } else {
      invalidCount++;
      if (failures.length < failureLimit) {
        failures.push({
          id: doc.id,
          version: doc.version,
          errors: (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message}`),
        });
      }
    }
  }

  return Response.json({
    collection,
    schemaSource,
    checked: docs.length,
    limitReached: docs.length >= maxDocs,
    valid: validCount,
    invalid: invalidCount,
    failures,
    failuresTruncated: invalidCount > failures.length,
  });
}

// ── Binary asset helpers ─────────────────────────────────────────────────────

async function insertAssetVersion(
  schemaName: string,
  docId: string,
  version: number,
  file: File,
  userId: string,
): Promise<void> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const meta = {
    _binary:  true,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size:     buffer.byteLength,
  };
  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${docId}, ${version}, ${tx.json(meta)}, ${userId})
    `;
    await tx`
      INSERT INTO asset_contents (document_id, version, data, mime_type, filename, size)
      VALUES (${docId}, ${version}, ${buffer}, ${meta.mimeType}, ${meta.filename}, ${meta.size})
    `;
  });
}

async function handleCreateAsset(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file field" }, { status: 400 });

  const docId = await withTenant(schemaName, async tx => {
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO documents (collection, current_version, created_by)
      VALUES (${collection}, 1, ${userId})
      RETURNING id
    `;
    return inserted.id;
  });

  await insertAssetVersion(schemaName, docId, 1, file, userId);

  const doc = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      SELECT id, created_at, updated_at FROM documents WHERE id = ${docId}
    `;
    return row;
  });

  return Response.json({
    id: doc.id, version: 1, collection,
    data: { _binary: true, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
    createdAt: doc.created_at, updatedAt: doc.updated_at,
  }, { status: 201 });
}

async function handleUpdateAsset(schemaName: string, collection: string, docId: string, req: Request, userId: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file field" }, { status: 400 });

  const existing = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents WHERE id = ${docId} AND collection = ${collection} AND deleted_at IS NULL
    `;
    return row;
  });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const newVersion = existing.current_version + 1;
  await insertAssetVersion(schemaName, docId, newVersion, file, userId);

  const doc = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
      WHERE id = ${docId}
      RETURNING id, created_at, updated_at
    `;
    return row;
  });

  return Response.json({
    id: doc.id, version: newVersion, collection,
    data: { _binary: true, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
    createdAt: doc.created_at, updatedAt: doc.updated_at,
  });
}

async function handleGetAssetRaw(schemaName: string, collection: string, docId: string, url: URL): Promise<Response> {
  const versionParam = url.searchParams.get("version");
  const rows = await withTenant(schemaName, async tx => {
    if (versionParam) {
      return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
        SELECT ac.data, ac.mime_type, ac.filename
        FROM asset_contents ac
        WHERE ac.document_id = ${docId} AND ac.version = ${parseInt(versionParam)}
      `;
    }
    return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
      SELECT ac.data, ac.mime_type, ac.filename
      FROM asset_contents ac
      JOIN documents d ON d.id = ac.document_id AND d.current_version = ac.version
      WHERE ac.document_id = ${docId} AND d.collection = ${collection} AND d.deleted_at IS NULL
    `;
  });
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, mime_type, filename } = rows[0];
  return new Response(data, {
    headers: {
      "Content-Type": mime_type,
      "Content-Disposition": `inline; filename="${filename}"`,
      // Short freshness, long stale-while-revalidate. Combined with explicit
      // purges on mutation, this keeps reads fast without serving stale bytes
      // for long when a new version is uploaded.
      "Cache-Control": PUBLIC_CACHE,
      // Tree-served raw bytes come from a content-negotiated URL, so the CDN
      // must key its cache by Accept — otherwise a JSON probe poisons the
      // HTML response for the same path.
      "Vary": "Accept",
    },
  });
}

// ── Public collection access (no auth required — gated by principal='*' rules) ──

async function handleListProjects(url: URL): Promise<Response> {
  // Find all orgs with at least one principal='*' permission, grouped by org.
  const rows = await sql<{
    org_id: string; slug: string; name: string; resource: string; access: string;
    label_filter: string | null;
  }[]>`
    SELECT p.org_id, s.slug, u.name, p.resource, p.access, p.label_filter
    FROM common.permissions p
    JOIN common.org_slugs s ON s.org_id = p.org_id
    JOIN "user" u ON u.id = p.org_id
    WHERE p.principal = '*'
    ORDER BY u.name, p.resource
  `;

  // Group by org
  const byOrg = new Map<string, {
    orgId: string; name: string; slug: string;
    collections: { name: string; access: string; labelFilter: string | null }[];
    trees: { name: string }[];
  }>();
  for (const r of rows) {
    if (!byOrg.has(r.org_id)) {
      byOrg.set(r.org_id, { orgId: r.org_id, name: r.name, slug: r.slug, collections: [], trees: [] });
    }
    const org = byOrg.get(r.org_id)!;
    const [kind, name] = r.resource.split(":");
    if (kind === "collection") {
      org.collections.push({ name, access: r.access, labelFilter: r.label_filter });
    } else if (kind === "tree") {
      org.trees.push({ name });
    }
  }

  // For each tree, check if it has an /index.html entry point (makes it a
  // browsable site/app). Query all tenant schemas in one go per org.
  const base = `${url.protocol}//${url.host}`;
  const projects = await Promise.all([...byOrg.values()].map(async org => {
    // Look up entry pages for all trees in this org's schema
    const schemaName = sanitizeSchemaName(org.orgId);
    let entryPaths: { tree: string; path: string }[] = [];
    try {
      entryPaths = await withTenant(schemaName, async tx =>
        tx<{ tree: string; path: string }[]>`
          SELECT tree, path FROM paths
          WHERE tree = ANY(${org.trees.map(t => t.name)})
            AND path = '/index.html'
        `
      );
    } catch { /* tenant may not exist */ }
    const entrySet = new Set(entryPaths.map(e => e.tree));

    return {
      name: org.name,
      slug: org.slug,
      url: `${base}/api/v1/orgs/${org.slug}`,
      collections: org.collections.map(c => ({
        name: c.name,
        access: c.access,
        labelFilter: c.labelFilter,
        url: `${base}/api/v1/orgs/${org.slug}/${c.name}`,
      })),
      trees: org.trees.map(t => ({
        name: t.name,
        url: `${base}/api/v1/orgs/${org.slug}/tree/${t.name}?full=true`,
        entryUrl: entrySet.has(t.name)
          ? `${base}/orgs/${org.slug}/tree/${t.name}/index.html`
          : null,
      })),
    };
  }));

  return Response.json({ projects }, {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
  });
}

async function handlePublicCollectionRequest(
  slug: string,
  collection: string,
  id: string | undefined,
  sub: string | undefined,
  url: URL,
  accept?: string | null,
): Promise<Response> {
  // Resolve org from slug
  const slugRows = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_slugs WHERE slug = ${slug}
  `;
  if (!slugRows.length) return Response.json({ error: "Not found" }, { status: 404 });
  const orgId = slugRows[0].org_id;

  const schemaName = sanitizeSchemaName(orgId);

  // ── Public tree access: GET /orgs/{slug}/tree/{treeName}[/{...path}] ──────
  if (collection === "tree") {
    const treeName = id;
    if (!treeName) return Response.json({ error: "Tree name required" }, { status: 400 });

    const treeResource = `tree:${treeName}`;
    const ar = await checkAccess(orgId, "", "*", treeResource, "read");
    if (!ar.allowed) return Response.json({ error: "Forbidden" }, { status: 403 });

    // Reconstruct the full tree path from the raw URL — support both the canonical
    // /api/v1/orgs/{slug}/tree/{treeName}/... and the short /orgs/{slug}/tree/{treeName}/... alias.
    const apiPrefix   = `/api/v1/orgs/${slug}/tree/${treeName}`;
    const shortPrefix = `/orgs/${slug}/tree/${treeName}`;
    const treePath = url.pathname.startsWith(apiPrefix)   ? url.pathname.slice(apiPrefix.length)   || "/" :
                     url.pathname.startsWith(shortPrefix) ? url.pathname.slice(shortPrefix.length) || "/" :
                     "/";

    const effectiveLabel = ar.labelFilter ?? url.searchParams.get("label") ?? undefined;
    if (url.searchParams.get("full") === "true") {
      return handleTreeFull(schemaName, treeName, effectiveLabel);
    }
    return handleTreeGet(schemaName, treeName, treePath, accept, effectiveLabel);
  }

  // ── Public collection access ───────────────────────────────────────────────
  const resource = `collection:${collection}`;
  const ar = await checkAccess(orgId, "", "*", resource, "read");
  if (!ar.allowed) return Response.json({ error: "Forbidden" }, { status: 403 });

  // GET /orgs/{slug}/{collection}/by-key/{keyValue} — public natural-key lookup.
  // Read-only; public mutations are never allowed regardless of how the rule
  // is configured (write/admin on principal=* is nonsensical here).
  if (id === "by-key" && sub) {
    const keyValue = decodeURIComponent(sub);
    const effectiveLabel = ar.labelFilter ?? url.searchParams.get("label") ?? undefined;
    const effectiveUrl = effectiveLabel
      ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
      : url;
    const r = await handleGetByKey(schemaName, collection, keyValue, effectiveUrl);
    return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
  }

  // GET /orgs/{slug}/{collection}/{id}/raw — serve binary asset.
  // handleGetAssetRaw already emits the public cache policy + Vary: Accept.
  if (id && sub === "raw") {
    return handleGetAssetRaw(schemaName, collection, id, url);
  }

  // GET /orgs/{slug}/{collection}/{id} — get JSON document
  if (id && !sub) {
    const effectiveLabel = ar.labelFilter ?? url.searchParams.get("label") ?? undefined;
    const effectiveUrl = effectiveLabel
      ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
      : url;
    const r = await handleGet(schemaName, collection, id, effectiveUrl);
    return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
  }

  // GET /orgs/{slug}/{collection} — list documents
  const r = await handleList(schemaName, collection, url, "", ar.labelFilter);
  return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
}

async function filterPublicResponse(res: Response, ar: AccessResult): Promise<Response> {
  if (!ar.filterExpr || !ar.filterLang) return res;
  const body = await res.json() as Record<string, unknown>;
  if (Array.isArray(body.items)) {
    body.items = await Promise.all(
      (body.items as { data: unknown }[]).map(async item => ({
        ...item,
        data: await applyDataFilter(item.data, ar.filterLang!, ar.filterExpr!),
      }))
    );
  } else if ("data" in body) {
    body.data = await applyDataFilter(body.data, ar.filterLang!, ar.filterExpr!);
  }
  return Response.json(body, { status: res.status });
}

async function handleCreate(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const data = await req.json();

  const errors = await validateAgainstSchema(schemaName, collection, data);
  if (errors) return Response.json({ error: "Schema validation failed", details: errors }, { status: 422 });

  // Extract natural key from incoming data (null if no key configured for
  // this collection, or if the field is missing / wrong type / empty).
  const naturalKey = await extractNaturalKey(schemaName, collection, data);

  try {
    const doc = await withTenant(schemaName, async tx => {
      const [inserted] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
        INSERT INTO documents (collection, current_version, natural_key, created_by)
        VALUES (${collection}, 1, ${naturalKey}, ${userId})
        RETURNING id, created_at, updated_at
      `;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${inserted.id}, 1, ${tx.json(data)}, ${userId})
      `;
      return inserted;
    });

    return Response.json(
      { id: doc.id, version: 1, collection, data, naturalKey, createdAt: doc.created_at, updatedAt: doc.updated_at },
      { status: 201 }
    );
  } catch (err) {
    if (isNaturalKeyConflict(err)) {
      return Response.json({
        error: "Natural key conflict",
        details: `Another document in '${collection}' already has natural_key='${naturalKey}'. Use PUT /by-key/${naturalKey} to update the existing document, or change the key field value.`,
      }, { status: 409 });
    }
    throw err;
  }
}

async function handleGet(schemaName: string, collection: string, id: string, url: URL): Promise<Response> {
  const label = url.searchParams.get("label");

  const row = await withTenant(schemaName, async tx => {
    if (label) {
      const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>`
        SELECT d.id, l.version, v.data, d.created_at, d.updated_at
        FROM documents d
        JOIN labels l ON l.document_id = d.id AND l.label = ${label}
        JOIN versions v ON v.document_id = d.id AND v.version = l.version
        WHERE d.id = ${id} AND d.collection = ${collection} AND d.deleted_at IS NULL
      `;
      return rows[0] ?? null;
    }
    const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date; labels: string[] }[]>`
      SELECT d.id, d.current_version AS version, v.data, d.created_at, d.updated_at,
             COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
      FROM documents d
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      LEFT JOIN labels l ON l.document_id = d.id
      WHERE d.id = ${id} AND d.collection = ${collection} AND d.deleted_at IS NULL
      GROUP BY d.id, d.current_version, v.data, d.created_at, d.updated_at
    `;
    return rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: row.id, version: row.version, collection, data: row.data, createdAt: row.created_at, updatedAt: row.updated_at, labels: row.labels });
}

async function handleUpdate(schemaName: string, collection: string, id: string, req: Request, userId: string): Promise<Response> {
  const data = await req.json();

  const errors = await validateAgainstSchema(schemaName, collection, data);
  if (errors) return Response.json({ error: "Schema validation failed", details: errors }, { status: 422 });

  // Re-extract the natural key from incoming data. If the user changed the
  // key field inside data, this moves the column too — the unique index
  // enforces uniqueness and we map conflicts back to 409.
  const naturalKey = await extractNaturalKey(schemaName, collection, data);

  try {
    const result = await withTenant(schemaName, async tx => {
      const [doc] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM documents
        WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!doc) return null;

      const newVersion = doc.current_version + 1;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${id}, ${newVersion}, ${tx.json(data)}, ${userId})
      `;
      const [updated] = await tx<{ updated_at: Date }[]>`
        UPDATE documents
        SET current_version = ${newVersion},
            natural_key = ${naturalKey},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING updated_at
      `;
      return { version: newVersion, updated_at: updated.updated_at };
    });

    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ id, version: result.version, collection, data, naturalKey, updatedAt: result.updated_at });
  } catch (err) {
    if (isNaturalKeyConflict(err)) {
      return Response.json({
        error: "Natural key conflict",
        details: `Another document in '${collection}' already has natural_key='${naturalKey}'. Pick a different value for the key field.`,
      }, { status: 409 });
    }
    throw err;
  }
}

async function handleDelete(schemaName: string, collection: string, id: string): Promise<Response> {
  const affected = await withTenant(schemaName, async tx => {
    const rows = await tx<{ id: string }[]>`
      UPDATE documents SET deleted_at = NOW()
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length;
  });

  if (!affected) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, deleted: true });
}

// ── Natural-key routes (GET/PUT/DELETE /{collection}/by-key/{keyValue}) ─────
//
// Thin wrappers that resolve the natural key to a document ID via the
// unique index and then hand off to the existing by-ID handlers.
// handleUpsertByKey is the exception — it's the headline operation and
// does its own INSERT-or-UPDATE in a single transaction, replacing the
// list-then-put idiom that every ingestion client otherwise reinvents.

// Resolves a natural key to the document row (id + current version) or null.
// Used by handleGetByKey and handleDeleteByKey to turn /by-key/{value} into
// a regular by-ID lookup.
async function resolveNaturalKey(
  schemaName: string,
  collection: string,
  keyValue: string,
): Promise<{ id: string } | null> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ id: string }[]>`
      SELECT id FROM documents
      WHERE collection = ${collection} AND natural_key = ${keyValue} AND deleted_at IS NULL
      LIMIT 1
    `
  );
  return rows[0] ?? null;
}

async function handleGetByKey(
  schemaName: string,
  collection: string,
  keyValue: string,
  url: URL,
): Promise<Response> {
  const field = await getNaturalKeyField(schemaName, collection);
  if (!field) {
    return Response.json({
      error: "No natural key configured",
      details: `Collection '${collection}' has no naturalKey set. Add one via PUT /api/v1/${collection}/_schema with {"naturalKey":"slug"}.`,
    }, { status: 400 });
  }
  const row = await resolveNaturalKey(schemaName, collection, keyValue);
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return handleGet(schemaName, collection, row.id, url);
}

async function handleUpsertByKey(
  schemaName: string,
  collection: string,
  keyValue: string,
  req: Request,
  userId: string,
): Promise<{ res: Response; id: string | null }> {
  const field = await getNaturalKeyField(schemaName, collection);
  if (!field) {
    return {
      res: Response.json({
        error: "No natural key configured",
        details: `Collection '${collection}' has no naturalKey set. Add one via PUT /api/v1/${collection}/_schema with {"naturalKey":"slug"}.`,
      }, { status: 400 }),
      id: null,
    };
  }

  const data = await req.json() as unknown;

  // If the body provides a value for the key field, it must match the URL.
  // Silently accepting a mismatch would put the "address" and "content" out
  // of sync; an explicit 400 is the kinder behaviour.
  if (data && typeof data === "object") {
    const bodyValue = (data as Record<string, unknown>)[field];
    if (typeof bodyValue === "string" && bodyValue.trim() !== keyValue) {
      return {
        res: Response.json({
          error: "Natural key mismatch",
          details: `URL key '${keyValue}' does not match data.${field} value '${bodyValue.trim()}'. Either update the URL or set ${field}='${keyValue}' in the body.`,
        }, { status: 400 }),
        id: null,
      };
    }
  }

  // If the body omitted the key field entirely, set it ourselves so that
  // the stored doc stays in sync with its addressable identity.
  let payload: Record<string, unknown>;
  if (data && typeof data === "object") {
    payload = { ...(data as Record<string, unknown>) };
    if (payload[field] === undefined || payload[field] === null) {
      payload[field] = keyValue;
    }
  } else {
    payload = { [field]: keyValue };
  }

  const errors = await validateAgainstSchema(schemaName, collection, payload);
  if (errors) {
    return {
      res: Response.json({ error: "Schema validation failed", details: errors }, { status: 422 }),
      id: null,
    };
  }

  try {
    const result = await withTenant(schemaName, async tx => {
      // Lookup-and-lock an existing doc with this key.
      const [existing] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM documents
        WHERE collection = ${collection} AND natural_key = ${keyValue} AND deleted_at IS NULL
        FOR UPDATE
      `;

      if (existing) {
        // Update path: write a new version against the existing doc.
        const newVersion = existing.current_version + 1;
        await tx`
          INSERT INTO versions (document_id, version, data, created_by)
          VALUES (${existing.id}, ${newVersion}, ${tx.json(payload)}, ${userId})
        `;
        const [updated] = await tx<{ updated_at: Date; created_at: Date }[]>`
          UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
          WHERE id = ${existing.id}
          RETURNING updated_at, created_at
        `;
        return { id: existing.id, version: newVersion, created: false, created_at: updated.created_at, updated_at: updated.updated_at };
      }

      // Insert path: create a fresh doc with this key.
      const [inserted] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
        INSERT INTO documents (collection, current_version, natural_key, created_by)
        VALUES (${collection}, 1, ${keyValue}, ${userId})
        RETURNING id, created_at, updated_at
      `;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${inserted.id}, 1, ${tx.json(payload)}, ${userId})
      `;
      return { id: inserted.id, version: 1, created: true, created_at: inserted.created_at, updated_at: inserted.updated_at };
    });

    return {
      res: Response.json(
        {
          id: result.id,
          version: result.version,
          collection,
          data: payload,
          naturalKey: keyValue,
          createdAt: result.created_at,
          updatedAt: result.updated_at,
        },
        { status: result.created ? 201 : 200 }
      ),
      id: result.id,
    };
  } catch (err) {
    if (isNaturalKeyConflict(err)) {
      // Shouldn't happen — we locked on (collection, natural_key) before writing.
      // But if it does (race under an unusual isolation level), return the
      // same 409 the regular create/update paths would.
      return {
        res: Response.json({
          error: "Natural key conflict",
          details: `Another document in '${collection}' already has natural_key='${keyValue}'.`,
        }, { status: 409 }),
        id: null,
      };
    }
    throw err;
  }
}

async function handleDeleteByKey(
  schemaName: string,
  collection: string,
  keyValue: string,
): Promise<{ res: Response; id: string | null }> {
  const field = await getNaturalKeyField(schemaName, collection);
  if (!field) {
    return {
      res: Response.json({
        error: "No natural key configured",
        details: `Collection '${collection}' has no naturalKey set.`,
      }, { status: 400 }),
      id: null,
    };
  }
  const row = await resolveNaturalKey(schemaName, collection, keyValue);
  if (!row) return { res: Response.json({ error: "Not found" }, { status: 404 }), id: null };
  const res = await handleDelete(schemaName, collection, row.id);
  return { res, id: row.id };
}

async function handleVersionList(schemaName: string, collection: string, id: string): Promise<Response> {
  const versions = await withTenant(schemaName, async tx => {
    // Verify doc exists
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;

    const rows = await tx<{ version: number; created_at: Date; created_by: string; labels: string[] }[]>`
      SELECT v.version, v.created_at, v.created_by,
             COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
      FROM versions v
      LEFT JOIN labels l ON l.document_id = v.document_id AND l.version = v.version
      WHERE v.document_id = ${id}
      GROUP BY v.version, v.created_at, v.created_by
      ORDER BY v.version ASC
    `;
    return rows.map(r => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by, labels: r.labels }));
  });

  if (!versions) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, versions });
}

async function handleVersionGet(schemaName: string, collection: string, id: string, versionStr: string): Promise<Response> {
  const version = parseInt(versionStr, 10);
  if (isNaN(version)) return Response.json({ error: "Invalid version" }, { status: 400 });

  const row = await withTenant(schemaName, async tx => {
    const rows = await tx<{ data: unknown; created_at: Date }[]>`
      SELECT v.data, v.created_at
      FROM versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = ${id} AND v.version = ${version}
        AND d.collection = ${collection}
    `;
    return rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, version, data: row.data, createdAt: row.created_at });
}

async function handleRollback(schemaName: string, collection: string, id: string, versionStr: string, userId: string): Promise<Response> {
  const targetVersion = parseInt(versionStr, 10);
  if (isNaN(targetVersion)) return Response.json({ error: "Invalid version" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!doc) return null;

    const [targetRow] = await tx<{ data: unknown }[]>`
      SELECT data FROM versions WHERE document_id = ${id} AND version = ${targetVersion}
    `;
    if (!targetRow) return null;

    const newVersion = doc.current_version + 1;
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${id}, ${newVersion}, ${tx.json(targetRow.data)}, ${userId})
    `;
    await tx`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW() WHERE id = ${id}
    `;
    return { newVersion, rolledBackTo: targetVersion };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, version: result.newVersion, rolledBackTo: result.rolledBackTo });
}

async function handleLabel(schemaName: string, collection: string, id: string, req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { label: string; version?: number };
  const { label } = body;
  if (!label) return Response.json({ error: "label is required" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;

    // Use explicitly requested version if provided, otherwise current
    const targetVersion = (typeof body.version === "number") ? body.version : doc.current_version;

    // Verify the target version exists
    const [vrow] = await tx<{ version: number }[]>`
      SELECT version FROM versions WHERE document_id = ${id} AND version = ${targetVersion}
    `;
    if (!vrow) return "version_not_found" as const;

    await tx`
      INSERT INTO labels (document_id, label, version, created_by)
      VALUES (${id}, ${label}, ${targetVersion}, ${userId})
      ON CONFLICT (document_id, label) DO UPDATE
        SET version = EXCLUDED.version, updated_at = NOW()
    `;
    return { label, version: targetVersion };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  if (result === "version_not_found") return Response.json({ error: "Version not found" }, { status: 404 });
  return Response.json({ id, label: result.label, version: result.version });
}

async function handleDocumentPaths(schemaName: string, collection: string, id: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;
    return tx<{ tree: string; path: string }[]>`
      SELECT tree, path FROM paths WHERE document_id = ${id} ORDER BY tree, path
    `;
  });
  if (!rows) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, paths: rows });
}

async function handleGetSchema(schemaName: string, collection: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ schema: unknown; display_name: string | null; collection_type: string; list_columns: string[] | null; natural_key: string | null; updated_at: Date }[]>`
      SELECT schema, display_name, collection_type, list_columns, natural_key, updated_at FROM collection_schemas WHERE collection = ${collection}
    `
  );
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    collection,
    collectionType: rows[0].collection_type,
    schema:         rows[0].collection_type === "binary" ? null : rows[0].schema,
    displayName:    rows[0].display_name ?? null,
    listColumns:    rows[0].list_columns ?? null,
    naturalKey:     rows[0].natural_key ?? null,
    updatedAt:      rows[0].updated_at,
  });
}

async function handleSetSchema(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  // Accept either a plain JSON Schema or a wrapper { schema?, displayName?, collectionType?, listColumns?, naturalKey? }
  const isWrapper = body && typeof body === "object" && ("schema" in body || "collectionType" in body || "displayName" in body || "listColumns" in body || "naturalKey" in body);
  const collectionType: string =
    (isWrapper && typeof body.collectionType === "string") ? body.collectionType : "json";
  const schema = collectionType === "binary"
    ? {}   // binary collections don't need a JSON Schema
    : (isWrapper ? body.schema : body) ?? {};
  const displayName: string | null =
    (isWrapper && typeof body.displayName === "string") ? body.displayName : null;
  const listColumns: string[] | null =
    (isWrapper && Array.isArray(body.listColumns) && body.listColumns.length > 0)
      ? (body.listColumns as string[]).filter(c => typeof c === "string" && c.trim())
      : null;
  // Natural key: the top-level field name in document data whose value
  // becomes the addressable identity. Explicit null or empty string clears it.
  const naturalKey: string | null =
    (isWrapper && typeof body.naturalKey === "string" && body.naturalKey.trim())
      ? body.naturalKey.trim()
      : null;

  if (collectionType !== "binary") {
    try { ajv.compile(schema as object); }
    catch (e) { return Response.json({ error: "Invalid JSON Schema", details: String(e) }, { status: 422 }); }
  }

  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO collection_schemas (collection, schema, display_name, collection_type, list_columns, natural_key, created_by)
      VALUES (${collection}, ${tx.json(schema)}, ${displayName}, ${collectionType}, ${listColumns}, ${naturalKey}, ${userId})
      ON CONFLICT (collection) DO UPDATE
        SET schema          = EXCLUDED.schema,
            display_name    = EXCLUDED.display_name,
            collection_type = EXCLUDED.collection_type,
            list_columns    = EXCLUDED.list_columns,
            natural_key     = EXCLUDED.natural_key,
            updated_at      = NOW()
    `;
  });
  // Invalidate the in-memory natural-key config cache for this collection
  // since the schema just changed.
  naturalKeyCache.delete(`${schemaName}:${collection}`);
  return Response.json({ collection, collectionType, schema: collectionType === "binary" ? null : schema, displayName, listColumns, naturalKey });
}

async function handleDeleteSchema(schemaName: string, collection: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection: string }[]>`
      DELETE FROM collection_schemas WHERE collection = ${collection} RETURNING collection
    `
  );
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ collection, deleted: true });
}

async function handleListCollections(schemaName: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection: string; count: string; updated_at: Date | null }[]>`
      SELECT
        COALESCE(d.collection, s.collection) AS collection,
        COALESCE(d.count, '0')               AS count,
        d.updated_at
      FROM (
        SELECT collection, COUNT(*)::text AS count, MAX(updated_at) AS updated_at
        FROM documents WHERE deleted_at IS NULL
        GROUP BY collection
      ) d
      FULL OUTER JOIN collection_schemas s ON d.collection = s.collection
      ORDER BY collection
    `
  );
  return Response.json({ collections: rows.map(r => ({ name: r.collection, count: parseInt(r.count), updatedAt: r.updated_at })) });
}

async function handleDiff(schemaName: string, collection: string, id: string, url: URL): Promise<Response> {
  const v1 = parseInt(url.searchParams.get("v1") ?? "", 10);
  const v2 = parseInt(url.searchParams.get("v2") ?? "", 10);
  if (isNaN(v1) || isNaN(v2)) return Response.json({ error: "v1 and v2 are required" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const rows = await tx<{ version: number; data: Record<string, unknown> }[]>`
      SELECT v.version, v.data
      FROM versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = ${id} AND v.version IN (${v1}, ${v2})
        AND d.collection = ${collection}
      ORDER BY v.version
    `;
    if (rows.length < 2) return null;
    const byVersion = Object.fromEntries(rows.map(r => [r.version, r.data]));
    return { before: byVersion[v1], after: byVersion[v2] };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, v1, v2, diff: computeDiff(result.before, result.after) });
}

// -------------------------------------------------------
// Tree handlers
// -------------------------------------------------------

async function handleListTrees(schemaName: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ tree: string; count: string }[]>`
      SELECT tree, COUNT(*)::text AS count FROM paths GROUP BY tree ORDER BY tree
    `
  );
  return Response.json({ trees: rows.map(r => ({ name: r.tree, count: parseInt(r.count) })) });
}

async function handleTreeFull(schemaName: string, treeName: string, label?: string): Promise<Response> {
  const nodes = await withTenant(schemaName, async tx => {
    if (label) {
      return tx<{ path: string; document_id: string; collection: string; version: number; data: unknown }[]>`
        SELECT p.path, p.document_id, d.collection, l.version, v.data
        FROM paths p
        JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
        JOIN labels l ON l.document_id = d.id AND l.label = ${label}
        JOIN versions v ON v.document_id = d.id AND v.version = l.version
        WHERE p.tree = ${treeName}
        ORDER BY p.path
      `;
    }
    return tx<{ path: string; document_id: string; collection: string; version: number; data: unknown }[]>`
      SELECT p.path, p.document_id, d.collection, d.current_version AS version, v.data
      FROM paths p
      JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE p.tree = ${treeName}
      ORDER BY p.path
    `;
  });
  return withHeaders(Response.json({
    tree: treeName,
    nodes: nodes.map(n => ({
      path: n.path,
      documentId: n.document_id,
      document: { id: n.document_id, collection: n.collection, version: n.version, data: n.data },
    })),
  }), PUBLIC_CACHE_HEADERS);
}

// Return true when the Accept header prefers a non-JSON content type over JSON.
// Browsers send e.g. "text/html,*/*;q=0.8" — no explicit application/json → serve binary.
// API clients that want JSON send "application/json" explicitly → serve JSON.
// No Accept header or "*/*" only (bare curl) → serve JSON for backwards compat.
function shouldServeBinary(accept: string | null): boolean {
  if (!accept) return false;
  const types = accept.split(",").map(p => p.trim().split(";")[0].trim());
  const hasJson = types.some(t => t === "application/json");
  const hasSpecific = types.some(t => t !== "*/*" && t !== "application/*");
  return hasSpecific && !hasJson;
}

async function handleTreeGet(schemaName: string, treeName: string, treePath: string, accept?: string | null, label?: string): Promise<Response> {
  const result = await withTenant(schemaName, async tx => {
    // Exact match at this path in this tree
    const [exact] = await tx<{ document_id: string; assignment_doc_id: string | null }[]>`
      SELECT document_id, assignment_doc_id FROM paths WHERE tree = ${treeName} AND path = ${treePath}
    `;

    // Direct children — paths one level deeper
    const prefix = treePath.replace(/\/$/, "") + "/";
    const children = await tx<{ document_id: string; path: string }[]>`
      SELECT document_id, path FROM paths
      WHERE tree = ${treeName} AND path LIKE ${prefix + "%"}
      ORDER BY path
    `;

    let doc = null;
    if (exact?.document_id) {
      if (label) {
        // Resolve the document at the labeled version — if the label doesn't
        // exist on this doc, treat it as if the document isn't there yet
        // (deployed but not promoted to this label).
        const [row] = await tx<{ id: string; collection: string; version: number; data: unknown }[]>`
          SELECT d.id, d.collection, l.version, v.data
          FROM documents d
          JOIN labels l ON l.document_id = d.id AND l.label = ${label}
          JOIN versions v ON v.document_id = d.id AND v.version = l.version
          WHERE d.id = ${exact.document_id} AND d.deleted_at IS NULL
        `;
        doc = row ?? null;
      } else {
        const [row] = await tx<{ id: string; collection: string; version: number; data: unknown }[]>`
          SELECT d.id, d.collection, d.current_version AS version, v.data
          FROM documents d
          JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
          WHERE d.id = ${exact.document_id} AND d.deleted_at IS NULL
        `;
        doc = row ?? null;
      }
    }

    const pathExists = !!exact;
    return { tree: treeName, path: treePath, document: doc, assignmentDocId: exact?.assignment_doc_id ?? null, pathExists, children: children.map(c => ({ path: c.path, documentId: c.document_id })) };
  });

  // 404 only if the path doesn't exist AND has no descendants
  if (!result.pathExists && result.children.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Content negotiation: if the document is a binary asset and the client prefers
  // a non-JSON content type (e.g. a browser requesting text/html or image/*), stream
  // the raw bytes directly instead of the JSON envelope.
  const doc = result.document;
  if (doc && shouldServeBinary(accept ?? null)) {
    const data = doc.data as Record<string, unknown>;
    if (data?._binary === true) {
      return handleGetAssetRaw(schemaName, doc.collection, doc.id, new URL("http://x/?version=" + doc.version));
    }
  }

  // Tree GET is content-negotiated — the same URL can return JSON or raw bytes
  // depending on Accept. Vary: Accept tells the CDN to key its cache on both.
  return withHeaders(Response.json(result), CONTENT_NEGOTIATED_HEADERS);
}

async function handleTreePut(schemaName: string, treeName: string, treePath: string, req: Request, userId: string, orgId: string): Promise<Response> {
  const body = await req.json() as { documentId?: string };
  const documentId = body.documentId || null;

  // Detect whether the tree already exists before we mutate it. If this PUT
  // creates the first path for a new tree, we'll return a one-off hint in
  // the response explaining that the tree is not publicly readable by default.
  const treeExistsBefore = await withTenant(schemaName, async tx => {
    const rows = await tx<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM paths WHERE tree = ${treeName}) AS exists
    `;
    return rows[0]?.exists ?? false;
  });

  await withTenant(schemaName, async tx => {
    // If a documentId is provided, verify it exists
    if (documentId) {
      const [doc] = await tx<{ id: string }[]>`
        SELECT id FROM documents WHERE id = ${documentId} AND deleted_at IS NULL
      `;
      if (!doc) throw new Error("Document not found");
    }

    // Get existing path row (if any) to find the assignment doc
    const [existing] = await tx<{ assignment_doc_id: string | null }[]>`
      SELECT assignment_doc_id FROM paths WHERE tree = ${treeName} AND path = ${treePath}
    `;

    if (documentId) {
      // Assign a document — create assignment tracking doc
      const assignmentData = { tree: treeName, path: treePath, documentId };
      let assignmentDocId: string;

      if (existing?.assignment_doc_id) {
        assignmentDocId = existing.assignment_doc_id;
        const [assignDoc] = await tx<{ current_version: number }[]>`
          SELECT current_version FROM documents WHERE id = ${assignmentDocId}
        `;
        const newVersion = assignDoc.current_version + 1;
        await tx`
          INSERT INTO versions (document_id, version, data, created_by)
          VALUES (${assignmentDocId}, ${newVersion}, ${tx.json(assignmentData)}, ${userId})
        `;
        await tx`
          UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
          WHERE id = ${assignmentDocId}
        `;
      } else {
        const [newDoc] = await tx<{ id: string }[]>`
          INSERT INTO documents (collection, current_version, created_by)
          VALUES ('_paths', 1, ${userId})
          RETURNING id
        `;
        assignmentDocId = newDoc.id;
        await tx`
          INSERT INTO versions (document_id, version, data, created_by)
          VALUES (${assignmentDocId}, 1, ${tx.json(assignmentData)}, ${userId})
        `;
      }

      await tx`
        INSERT INTO paths (document_id, tree, path, assignment_doc_id)
        VALUES (${documentId}, ${treeName}, ${treePath}, ${assignmentDocId})
        ON CONFLICT (tree, path) DO UPDATE
          SET document_id = EXCLUDED.document_id,
              assignment_doc_id = EXCLUDED.assignment_doc_id
      `;
    } else {
      // Create an empty folder or unassign a document (clear document_id)
      await tx`
        INSERT INTO paths (document_id, tree, path)
        VALUES (${null}, ${treeName}, ${treePath})
        ON CONFLICT (tree, path) DO UPDATE
          SET document_id = NULL
      `;
    }
  });

  const response: Record<string, unknown> = { tree: treeName, path: treePath, documentId };

  // If this PUT just brought a new tree into existence, check whether a
  // public read rule is in place and include a one-off hint in the response
  // telling the caller how to make the tree publicly readable. This catches
  // the silent "I created a tree but reads return 403" footgun at creation
  // time instead of later.
  if (!treeExistsBefore) {
    const publicRule = await sql<{ id: string }[]>`
      SELECT id FROM common.permissions
      WHERE org_id = ${orgId}
        AND principal = '*'
        AND access IN ('read', 'write', 'admin')
        AND (resource = ${"tree:" + treeName} OR resource = 'tree:*' OR resource = '*')
      LIMIT 1
    `;
    response.hint = {
      created_tree: treeName,
      message: publicRule.length > 0
        ? `Tree '${treeName}' created. A public read rule already covers it, so reads via /orgs/{slug}/tree/${treeName}/... will work without auth.`
        : `Tree '${treeName}' created. It is not publicly readable by default — only authenticated users with a matching permission rule can read from it. To make it publicly readable, create a permission rule with principal='*' on resource='tree:${treeName}'.`,
      public_read_example: publicRule.length > 0 ? undefined : {
        method: "POST",
        url: "/api/v1/permissions",
        body: { principal: "*", resource: `tree:${treeName}`, access: "read" },
      },
    };
  }

  return Response.json(response);
}

async function handleTreeDelete(schemaName: string, treeName: string, treePath: string, userId: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx => {
    const [existing] = await tx<{ path: string; assignment_doc_id: string | null }[]>`
      DELETE FROM paths WHERE tree = ${treeName} AND path = ${treePath}
      RETURNING path, assignment_doc_id
    `;
    if (!existing) return null;

    // Record a tombstone version on the assignment document
    if (existing.assignment_doc_id) {
      const [assignDoc] = await tx<{ current_version: number }[]>`
        SELECT current_version FROM documents WHERE id = ${existing.assignment_doc_id}
      `;
      const newVersion = assignDoc.current_version + 1;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${existing.assignment_doc_id}, ${newVersion},
                ${tx.json({ tree: treeName, path: treePath, documentId: null, removed: true })},
                ${userId})
      `;
      await tx`
        UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
        WHERE id = ${existing.assignment_doc_id}
      `;
    }

    return existing;
  });

  if (!rows) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ tree: treeName, path: treePath, removed: true });
}

// -------------------------------------------------------
// API key handlers
// -------------------------------------------------------

async function handleListApiKeys(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const keys = await sql<{
    id: string; name: string; key_prefix: string;
    created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
    FROM common.api_keys
    WHERE org_id = ${orgId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  return Response.json({
    keys: keys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key_prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
  });
}

async function handleCreateApiKey(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as { name?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const rawKey = generateApiKey();
  const keyHash = await sha256hex(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const [key] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO common.api_keys (user_id, org_id, name, key_hash, key_prefix)
    VALUES (${userId}, ${orgId}, ${name}, ${keyHash}, ${keyPrefix})
    RETURNING id, created_at
  `;
  return Response.json({
    id: key.id,
    name,
    keyPrefix,
    key: rawKey, // returned once only — never stored in plaintext
    createdAt: key.created_at,
    lastUsedAt: null,
    revokedAt: null,
  }, { status: 201 });
}

async function handleRevokeApiKey(keyId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{ id: string }[]>`
    UPDATE common.api_keys
    SET revoked_at = NOW()
    WHERE id = ${keyId} AND org_id = ${orgId} AND revoked_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: keyId, revoked: true });
}

// -------------------------------------------------------
// Org context handlers
// -------------------------------------------------------

async function handleGetMe(user: SessionUser): Promise<Response> {
  const orgId = await resolveUserOrgId(user.userId, user.sessionId, user.keyOrgId);
  const isOwnOrg = orgId === user.userId;

  // Org display name + slug (match handleGetOrg logic)
  const orgUserRows = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM "user" WHERE id = ${orgId}
  `;
  const orgUser = orgUserRows[0];
  const orgSlug = orgUser ? await getOrCreateSlug(orgId, orgUser.email) : null;
  const orgName = isOwnOrg ? "My workspace" : (orgUser?.name ?? orgId);

  // Role is the single source of truth for what this caller can do in this
  // org. "owner" covers the personal-workspace case — no separate `own` flag.
  let role: string;
  if (isOwnOrg) {
    role = "owner";
  } else {
    const memberRows = await sql<{ role: string }[]>`
      SELECT role FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${user.userId}
    `;
    role = memberRows[0]?.role ?? "none";
  }

  // API-key details (only when authenticated via key)
  let apiKey: { id: string; name: string; prefix: string; lastUsedAt: Date | null } | null = null;
  if (user.keyId) {
    const keyRows = await sql<{ id: string; name: string; key_prefix: string; last_used_at: Date | null }[]>`
      SELECT id, name, key_prefix, last_used_at FROM common.api_keys WHERE id = ${user.keyId}
    `;
    if (keyRows[0]) {
      apiKey = {
        id: keyRows[0].id,
        name: keyRows[0].name,
        prefix: keyRows[0].key_prefix,
        lastUsedAt: keyRows[0].last_used_at,
      };
    }
  }

  // Permission rules that apply to this principal in this org, plus public (*) rules.
  // Lets an API-keyed caller self-audit its scope without needing admin access to
  // read the full /api/permissions list.
  const principal = principalFor(user);
  const permRows = await sql<{
    id: string; principal: string; resource: string; access: string;
    label_filter: string | null; filter_lang: string | null; filter_expr: string | null;
  }[]>`
    SELECT id, principal, resource, access, label_filter, filter_lang, filter_expr
    FROM common.permissions
    WHERE org_id = ${orgId} AND principal IN (${principal}, '*')
    ORDER BY created_at DESC
  `;

  return Response.json({
    principal,
    authMethod: user.keyId ? "api_key" : "session",
    user: { id: user.userId, name: user.name, email: user.email },
    org: { id: orgId, name: orgName, slug: orgSlug, role },
    apiKey,
    permissions: permRows.map(r => ({
      id: r.id,
      principal: r.principal,
      resource: r.resource,
      access: r.access,
      labelFilter: r.label_filter,
      filterLang: r.filter_lang,
      filterExpr: r.filter_expr,
    })),
  });
}

async function handleGetOrg(userId: string, sessionId: string | null): Promise<Response> {
  const current = await resolveUserOrgId(userId, sessionId);

  // All orgs accessible to this user: own + any they're a member of
  const memberships = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_members WHERE user_id = ${userId}
  `;
  const foreignIds = memberships.map(m => m.org_id);
  const owners = foreignIds.length
    ? await sql<{ id: string; name: string; email: string }[]>`
        SELECT id, name, email FROM "user" WHERE id = ANY(${foreignIds})
      `
    : [];

  // Fetch the current user's email for slug creation
  const selfRows = await sql<{ email: string }[]>`
    SELECT email FROM "user" WHERE id = ${userId}
  `;
  const selfEmail = selfRows[0]?.email ?? userId;
  const selfSlug = await getOrCreateSlug(userId, selfEmail);

  const foreignOrgs = await Promise.all(
    owners.map(async o => ({
      id: o.id,
      name: o.name,
      email: o.email,
      slug: await getOrCreateSlug(o.id, o.email),
      own: false,
    }))
  );

  const orgs = [
    { id: userId, name: "My workspace", slug: selfSlug, own: true },
    ...foreignOrgs,
  ];

  return Response.json({ current, orgs });
}

async function handleSwitchOrg(req: Request, userId: string, sessionId: string | null): Promise<Response> {
  if (!sessionId) {
    return Response.json({ error: "Org switching requires a browser session, not an API key" }, { status: 400 });
  }
  const body = await req.json() as { orgId?: string };
  const orgId = body.orgId?.trim();
  if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });

  // Validate: must be own org or an org the user is a member of
  if (orgId !== userId) {
    const rows = await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.org_members
      WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    if (!rows.length) return Response.json({ error: "Not a member of that org" }, { status: 403 });
  }

  await sql`
    INSERT INTO common.session_orgs (session_id, org_id)
    VALUES (${sessionId}, ${orgId})
    ON CONFLICT (session_id) DO UPDATE SET org_id = ${orgId}, updated_at = NOW()
  `;

  return Response.json({ current: orgId });
}

// -------------------------------------------------------
// Org usage handler
// -------------------------------------------------------

// Cache disk usage per org: orgId → { bytes, fetchedAt }
const diskUsageCache = new Map<string, { bytes: number; fetchedAt: number }>();
const DISK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function handleGetOrgUsage(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const schemaName = sanitizeSchemaName(orgId);

  // Disk usage — cached 5 minutes
  let diskBytes: number;
  const cached = diskUsageCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < DISK_CACHE_TTL_MS) {
    diskBytes = cached.bytes;
  } else {
    // Sum pg_relation_size() across all tables in the tenant schema
    const rows = await sql<{ total_bytes: string }[]>`
      SELECT COALESCE(SUM(pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0)::text AS total_bytes
      FROM pg_tables
      WHERE schemaname = ${schemaName}
    `.catch(() => [{ total_bytes: "0" }]);
    diskBytes = parseInt(rows[0]?.total_bytes ?? "0", 10);
    diskUsageCache.set(orgId, { bytes: diskBytes, fetchedAt: Date.now() });
  }

  // Include in-memory (unflushed) counts in the today totals
  const inMemory = requestStats.get(orgId) ?? { reads: 0, writes: 0 };
  const today = new Date().toISOString().split("T")[0];

  // Last 30 days from DB (already-flushed counts)
  const statsRows = await sql<{ date: string; reads: string; writes: string }[]>`
    SELECT date::text, reads::text, writes::text
    FROM common.request_stats
    WHERE org_id = ${orgId}
      AND date >= CURRENT_DATE - INTERVAL '29 days'
    ORDER BY date DESC
  `.catch(() => [] as { date: string; reads: string; writes: string }[]);

  // Merge today's in-memory counts into the stats rows
  const dailyStats = statsRows.map(r => ({
    date: r.date,
    reads: parseInt(r.reads, 10) + (r.date === today ? inMemory.reads : 0),
    writes: parseInt(r.writes, 10) + (r.date === today ? inMemory.writes : 0),
  }));
  // If today has no DB row yet, prepend it (if there's in-memory activity)
  if (!statsRows.find(r => r.date === today) && (inMemory.reads > 0 || inMemory.writes > 0)) {
    dailyStats.unshift({ date: today, reads: inMemory.reads, writes: inMemory.writes });
  }

  const totalReads  = dailyStats.reduce((s, r) => s + r.reads,  0);
  const totalWrites = dailyStats.reduce((s, r) => s + r.writes, 0);

  return Response.json({
    disk: { bytes: diskBytes },
    requests: {
      last30Days: { reads: totalReads, writes: totalWrites },
      daily: dailyStats,
    },
  });
}

// -------------------------------------------------------
// Slug + llms.txt handlers
// -------------------------------------------------------

async function handleSetOrgSlug(req: Request, userId: string, sessionId: string | null): Promise<Response> {
  const currentOrgId = await resolveUserOrgId(userId, sessionId);
  // Only the org owner can set their own slug
  if (currentOrgId !== userId) {
    return Response.json({ error: "Only the org owner can set the slug" }, { status: 403 });
  }
  const body = await req.json() as { slug?: string };
  const slug = body.slug?.trim();
  if (!slug) return Response.json({ error: "slug is required" }, { status: 400 });
  try {
    await setSlug(userId, slug);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Invalid slug")) return Response.json({ error: msg }, { status: 400 });
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists")) {
      return Response.json({ error: "Slug already taken" }, { status: 409 });
    }
    throw e;
  }
  return Response.json({ slug });
}

// Resolve a slug to its orgId. Returns null if not found.
async function resolveSlugToOrgId(slug: string): Promise<string | null> {
  const rows = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_slugs WHERE slug = ${slug}
  `;
  return rows[0]?.org_id ?? null;
}

// Determine which collections are publicly accessible for an org.
// Returns: { collectionNames: string[], allPublic: boolean, publicTrees: string[] | null (null = all) }
async function getPublicResources(orgId: string): Promise<{ collections: Set<string> | "all"; trees: Set<string> | "all" }> {
  const perms = await sql<{ resource: string }[]>`
    SELECT resource FROM common.permissions
    WHERE org_id = ${orgId}
      AND principal = '*'
      AND access IN ('read', 'write', 'admin')
  `;

  let collectionAll = false;
  let treeAll = false;
  const collections = new Set<string>();
  const trees = new Set<string>();

  for (const p of perms) {
    const r = p.resource;
    if (r === "*" || r === "collection:*") collectionAll = true;
    else if (r.startsWith("collection:")) collections.add(r.slice("collection:".length));
    if (r === "*" || r === "tree:*") treeAll = true;
    else if (r.startsWith("tree:")) trees.add(r.slice("tree:".length));
  }

  return {
    collections: collectionAll ? "all" : collections,
    trees: treeAll ? "all" : trees,
  };
}

// Generate llms.txt markdown for an org.
async function generateLlmsTxt(
  orgId: string,
  orgName: string,
  slug: string,
  base: string,
  accessibleCollections: string[],
  accessibleTrees: string[],
  authenticated: boolean,
): Promise<string> {
  const schema = sanitizeSchemaName(orgId);

  // Check if the tenant schema exists
  const schemaExists = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
    ) AS exists
  `;
  if (!schemaExists[0]?.exists) {
    const date = new Date().toISOString().split("T")[0];
    return [
      `# ${orgName} — Wren data context`,
      ``,
      `> Versioned JSON document store. No collections yet.`,
      ``,
      `*${authenticated ? "Authenticated" : "Public"} data context. Generated ${date}.*`,
      ``,
      `## Access`,
      ``,
      `Base URL: ${base}`,
      `API docs: ${base}/docs`,
      authenticated ? `` : `Full authenticated context: ${base}/api/v1/orgs/${slug}/llms.txt`,
    ].filter(l => l !== undefined).join("\n");
  }

  // Collect per-collection data
  type CollectionData = {
    name: string;
    count: number;
    schema: Record<string, unknown> | null;
    labels: { label: string; count: number }[];
    samples: { id: string; version: number; labels: string[]; data: unknown }[];
  };

  const collectionData: CollectionData[] = [];

  for (const col of accessibleCollections) {
    // Count
    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM ${sql.unsafe(schema)}.documents
      WHERE collection = ${col} AND deleted_at IS NULL
    `;
    const count = parseInt(countRows[0]?.count ?? "0", 10);

    // Schema
    const schemaRows = await sql<{ schema: unknown }[]>`
      SELECT schema FROM ${sql.unsafe(schema)}.collection_schemas
      WHERE collection = ${col}
    `;
    const colSchema = (schemaRows[0]?.schema ?? null) as Record<string, unknown> | null;

    // Labels in use
    const labelRows = await sql<{ label: string; count: string }[]>`
      SELECT DISTINCT l.label, COUNT(DISTINCT l.document_id)::text AS count
      FROM ${sql.unsafe(schema)}.labels l
      JOIN ${sql.unsafe(schema)}.documents d ON d.id = l.document_id
      WHERE d.collection = ${col} AND d.deleted_at IS NULL
      GROUP BY l.label
      ORDER BY count DESC
    `;
    const labels = labelRows.map(r => ({ label: r.label, count: parseInt(r.count, 10) }));

    // Sample documents
    const sampleRows = await sql<{ data: unknown; id: string; current_version: number; labels: string[] }[]>`
      SELECT v.data, d.id, d.current_version,
             ARRAY(SELECT label FROM ${sql.unsafe(schema)}.labels WHERE document_id = d.id ORDER BY label) AS labels
      FROM ${sql.unsafe(schema)}.documents d
      JOIN ${sql.unsafe(schema)}.versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.collection = ${col} AND d.deleted_at IS NULL
      ORDER BY d.updated_at DESC NULLS LAST
      LIMIT 3
    `;
    const samples = sampleRows.map(r => ({
      id: r.id,
      version: r.current_version,
      labels: r.labels,
      data: r.data,
    }));

    collectionData.push({ name: col, count, schema: colSchema, labels, samples });
  }

  const totalDocs = collectionData.reduce((s, c) => s + c.count, 0);
  const date = new Date().toISOString().split("T")[0];

  const lines: string[] = [
    `# ${orgName} — Wren data context`,
    ``,
    `> Versioned JSON document store. ${accessibleCollections.length} collections, ${totalDocs} total documents.`,
    ``,
    `*${authenticated ? "Authenticated" : "Public"} data context. Generated ${date}.*`,
    ``,
    `## Collections`,
    ``,
  ];

  if (collectionData.length === 0) {
    lines.push("No public collections.");
  }

  for (const col of collectionData) {
    lines.push(`### ${col.name} (${col.count} documents)`);

    // Schema summary
    if (col.schema && typeof col.schema === "object") {
      const props = (col.schema as { properties?: Record<string, { type?: string; enum?: unknown[] }> }).properties;
      if (props) {
        const fields = Object.entries(props).map(([k, v]) => {
          const typePart = v.type ?? "any";
          const enumPart = Array.isArray(v.enum) ? ` (enum: ${v.enum.join("|")})` : "";
          return `${k}: ${typePart}${enumPart}`;
        });
        lines.push(`Schema: ${fields.join(", ")}`);
      } else {
        lines.push("Schema: schema-free");
      }
    } else {
      lines.push("Schema: schema-free");
    }

    // Labels
    if (col.labels.length) {
      lines.push(`Labels in use: ${col.labels.map(l => `${l.label} (${l.count} docs)`).join(", ")}`);
    } else {
      lines.push("Labels in use: none");
    }

    // Sample documents
    lines.push("Sample documents:");
    if (col.samples.length === 0) {
      lines.push("- (no documents)");
    }
    for (const s of col.samples) {
      const displayName = (s.data as Record<string, unknown>)?.name ?? (s.data as Record<string, unknown>)?.title ?? s.id;
      const labelStr = s.labels.length ? s.labels.join(", ") : "none";
      const raw = JSON.stringify(s.data);
      const dataStr = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      lines.push(`- "${displayName}" (v${s.version}, labels: ${labelStr})`);
      lines.push(`  ${dataStr}`);
    }
    lines.push("");
  }

  // Trees section
  if (accessibleTrees.length > 0) {
    lines.push("## Trees", "");

    for (const treeName of accessibleTrees) {
      const pathRows = await sql<{ path: string; document_id: string; collection: string }[]>`
        SELECT p.path, p.document_id, d.collection
        FROM ${sql.unsafe(schema)}.paths p
        JOIN ${sql.unsafe(schema)}.documents d ON d.id = p.assignment_doc_id
        WHERE p.tree = ${treeName}
        ORDER BY p.path
        LIMIT 20
      `;

      const totalPaths = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM ${sql.unsafe(schema)}.paths WHERE tree = ${treeName}
      `;
      const pathCount = parseInt(totalPaths[0]?.count ?? "0", 10);

      lines.push(`### ${treeName} (${pathCount} paths)`);
      for (const p of pathRows) {
        lines.push(`${p.path} → ${p.collection}/${p.document_id}`);
      }
      if (pathCount > 20) lines.push(`… (${pathCount - 20} more paths not shown)`);
      lines.push("");
    }
  }

  lines.push("## Access", "");
  lines.push(`Base URL: ${base}`);
  lines.push(`API docs: ${base}/docs`);
  if (!authenticated) {
    lines.push(`Full authenticated context: ${base}/api/v1/orgs/${slug}/llms.txt`);
  } else {
    lines.push(`API key creation: POST ${base}/api/keys`);
  }

  return lines.join("\n");
}

async function handleOrgLlmsTxt(slug: string | undefined, url: URL, user: SessionUser | null): Promise<Response> {
  if (!slug) return new Response("Slug required", { status: 400 });

  const orgId = await resolveSlugToOrgId(slug);
  if (!orgId) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const base = `${url.protocol}//${url.host}`;
  const authenticated = user !== null;

  // Determine org name
  const orgUserRows = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM "user" WHERE id = ${orgId}
  `;
  const orgName = orgUserRows[0]?.name ?? slug;
  const orgEmail = orgUserRows[0]?.email ?? "";

  let accessibleCollections: string[];
  let accessibleTrees: string[];

  if (authenticated && (user!.userId === orgId || (() => false)())) {
    // Authenticated as owner: show all collections
    const colRows = await sql<{ collection: string }[]>`
      SELECT DISTINCT collection FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.documents
      WHERE deleted_at IS NULL
      ORDER BY collection
    `.catch(() => [] as { collection: string }[]);
    accessibleCollections = colRows.map(r => r.collection);

    const treeRows = await sql<{ tree: string }[]>`
      SELECT DISTINCT tree FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.paths ORDER BY tree
    `.catch(() => [] as { tree: string }[]);
    accessibleTrees = treeRows.map(r => r.tree);
  } else if (authenticated) {
    // Authenticated as someone else: check membership + permissions
    const isMember = user!.userId === orgId || (await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${user!.userId}
    `).length > 0;

    if (isMember) {
      const colRows = await sql<{ collection: string }[]>`
        SELECT DISTINCT collection FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.documents
        WHERE deleted_at IS NULL
        ORDER BY collection
      `.catch(() => [] as { collection: string }[]);
      accessibleCollections = colRows.map(r => r.collection);

      const treeRows = await sql<{ tree: string }[]>`
        SELECT DISTINCT tree FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.paths ORDER BY tree
      `.catch(() => [] as { tree: string }[]);
      accessibleTrees = treeRows.map(r => r.tree);
    } else {
      // Not a member — fall back to public access rules
      const resources = await getPublicResources(orgId);
      if (resources.collections === "all") {
        const colRows = await sql<{ collection: string }[]>`
          SELECT DISTINCT collection FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.documents
          WHERE deleted_at IS NULL ORDER BY collection
        `.catch(() => [] as { collection: string }[]);
        accessibleCollections = colRows.map(r => r.collection);
      } else {
        accessibleCollections = Array.from(resources.collections as Set<string>);
      }
      if (resources.trees === "all") {
        const treeRows = await sql<{ tree: string }[]>`
          SELECT DISTINCT tree FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.paths ORDER BY tree
        `.catch(() => [] as { tree: string }[]);
        accessibleTrees = treeRows.map(r => r.tree);
      } else {
        accessibleTrees = Array.from(resources.trees as Set<string>);
      }
    }
  } else {
    // Unauthenticated: public access only
    const resources = await getPublicResources(orgId);
    if (resources.collections === "all") {
      const colRows = await sql<{ collection: string }[]>`
        SELECT DISTINCT collection FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.documents
        WHERE deleted_at IS NULL ORDER BY collection
      `.catch(() => [] as { collection: string }[]);
      accessibleCollections = colRows.map(r => r.collection);
    } else {
      accessibleCollections = Array.from(resources.collections as Set<string>);
    }
    if (resources.trees === "all") {
      const treeRows = await sql<{ tree: string }[]>`
        SELECT DISTINCT tree FROM ${sql.unsafe(sanitizeSchemaName(orgId))}.paths ORDER BY tree
      `.catch(() => [] as { tree: string }[]);
      accessibleTrees = treeRows.map(r => r.tree);
    } else {
      accessibleTrees = Array.from(resources.trees as Set<string>);
    }
  }

  const body = await generateLlmsTxt(orgId, orgName, slug, base, accessibleCollections, accessibleTrees, authenticated);
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function handleWellKnownLlmsTxt(url: URL): Promise<Response> {
  // Find the instance owner: the user with the earliest created_at
  const ownerRows = await sql<{ id: string; email: string }[]>`
    SELECT id, email FROM "user" ORDER BY created_at ASC LIMIT 1
  `;
  if (!ownerRows.length) {
    return new Response("# Wren — no users yet\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const owner = ownerRows[0];
  const slug = await getOrCreateSlug(owner.id, owner.email);
  return handleOrgLlmsTxt(slug, url, null);
}

// -------------------------------------------------------
// Invite handlers
// -------------------------------------------------------

async function handleListInvites(userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const invites = await sql<{
    id: string; email: string; role: string;
    created_at: Date; expires_at: Date;
    accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at
    FROM common.invites
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
  `;
  return Response.json({
    invites: invites.map(i => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      acceptedAt: i.accepted_at,
      revokedAt: i.revoked_at,
    })),
  });
}

async function handleCreateInvite(req: Request, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as { email?: string; role?: string };
  const email = body.email?.trim().toLowerCase();
  const role = body.role ?? "member";
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });

  const rawToken = generateInviteToken();
  const tokenHash = await sha256hex(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  const [invite] = await sql<{ id: string; created_at: Date; expires_at: Date }[]>`
    INSERT INTO common.invites (org_id, email, token_hash, token_prefix, role, invited_by)
    VALUES (${orgId}, ${email}, ${tokenHash}, ${tokenPrefix}, ${role}, ${userId})
    RETURNING id, created_at, expires_at
  `;
  return Response.json({
    id: invite.id,
    email,
    role,
    token: rawToken, // returned once only — never stored in plaintext
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    acceptedAt: null,
    revokedAt: null,
  }, { status: 201 });
}

async function handleListReceivedInvites(user: SessionUser): Promise<Response> {
  const [u] = await sql<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${user.userId}`;
  if (!u) return Response.json({ invites: [] });

  const invites = await sql<{
    id: string; org_id: string; role: string;
    created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
    owner_name: string; owner_email: string;
  }[]>`
    SELECT i.id, i.org_id, i.role, i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
           own.name AS owner_name, own.email AS owner_email
    FROM common.invites i
    JOIN "user" own ON own.id = i.org_id
    WHERE i.email = ${u.email}
    ORDER BY i.created_at DESC
  `;
  return Response.json({
    invites: invites.map(i => ({
      id: i.id,
      orgId: i.org_id,
      orgName: i.owner_name,
      orgEmail: i.owner_email,
      role: i.role,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      acceptedAt: i.accepted_at,
      revokedAt: i.revoked_at,
    })),
  });
}

// Accept an invite by ID — no token required, validates that the logged-in user's email matches
async function handleAcceptInviteById(inviteId: string, user: SessionUser): Promise<Response> {
  const [u] = await sql<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${user.userId}`;
  if (!u) return Response.json({ error: "User not found" }, { status: 404 });

  const [invite] = await sql<{
    id: string; org_id: string; email: string; role: string;
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at
    FROM common.invites WHERE id = ${inviteId}
  `;
  if (!invite)            return Response.json({ error: "Invite not found" }, { status: 404 });
  if (invite.email !== u.email)
                          return Response.json({ error: "This invite is for a different email address" }, { status: 403 });
  if (invite.revoked_at)  return Response.json({ error: "Invite has been revoked" }, { status: 410 });
  if (invite.accepted_at) return Response.json({ error: "Invite already accepted" }, { status: 409 });
  if (new Date(invite.expires_at) < new Date())
                          return Response.json({ error: "Invite has expired" }, { status: 410 });
  if (invite.org_id === user.userId)
                          return Response.json({ error: "Cannot accept your own invite" }, { status: 400 });

  await sql`
    INSERT INTO common.org_members (org_id, user_id, role)
    VALUES (${invite.org_id}, ${user.userId}, ${invite.role})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${invite.role}
  `;
  await sql`UPDATE common.invites SET accepted_at = NOW() WHERE id = ${invite.id}`;

  return Response.json({ accepted: true, orgId: invite.org_id });
}

async function handleRevokeInvite(inviteId: string, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{ id: string }[]>`
    UPDATE common.invites
    SET revoked_at = NOW()
    WHERE id = ${inviteId} AND org_id = ${orgId} AND revoked_at IS NULL AND accepted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: inviteId, revoked: true });
}

async function handleAcceptInvite(req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { token?: string };
  const token = body.token?.trim();
  if (!token) return Response.json({ error: "token is required" }, { status: 400 });

  const tokenHash = await sha256hex(token);
  const [invite] = await sql<{
    id: string; org_id: string; email: string; role: string;
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at
    FROM common.invites WHERE token_hash = ${tokenHash}
  `;
  if (!invite)             return Response.json({ error: "Invalid invite token" }, { status: 404 });
  if (invite.revoked_at)   return Response.json({ error: "Invite has been revoked" }, { status: 410 });
  if (invite.accepted_at)  return Response.json({ error: "Invite already accepted" }, { status: 409 });
  if (new Date(invite.expires_at) < new Date())
                           return Response.json({ error: "Invite has expired" }, { status: 410 });
  if (invite.org_id === userId)
                           return Response.json({ error: "Cannot accept your own invite" }, { status: 400 });

  await sql`
    INSERT INTO common.org_members (org_id, user_id, role)
    VALUES (${invite.org_id}, ${userId}, ${invite.role})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${invite.role}
  `;
  await sql`UPDATE common.invites SET accepted_at = NOW() WHERE id = ${invite.id}`;

  return Response.json({ accepted: true, orgId: invite.org_id });
}

// -------------------------------------------------------
// Member handlers
// -------------------------------------------------------

async function handleListMembers(userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const members = await sql<{ user_id: string; role: string; joined_at: Date; name: string; email: string }[]>`
    SELECT m.user_id, m.role, m.joined_at, u.name, u.email
    FROM common.org_members m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.org_id = ${orgId}
    ORDER BY m.joined_at ASC
  `;
  return Response.json({
    members: members.map(m => ({
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      name: m.name,
      email: m.email,
    })),
  });
}

async function handleRemoveMember(memberId: string, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  // Prevent removing yourself
  if (memberId === userId) return Response.json({ error: "Cannot remove yourself" }, { status: 400 });

  const rows = await sql<{ user_id: string }[]>`
    DELETE FROM common.org_members
    WHERE org_id = ${orgId} AND user_id = ${memberId}
    RETURNING user_id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ userId: memberId, removed: true });
}

// -------------------------------------------------------
// Permission handlers (owner-only: only the org owner can manage permissions)
// -------------------------------------------------------

/** Returns true if userId is the org owner OR has role 'admin' in that org. */
async function isOrgAdminOrOwner(userId: string, orgId: string): Promise<boolean> {
  if (userId === orgId) return true;
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${userId}
  `;
  return rows.length > 0 && rows[0].role === "admin";
}

async function forbiddenIfNotAdminOrOwner(userId: string, orgId: string): Promise<Response | null> {
  if (await isOrgAdminOrOwner(userId, orgId)) return null;
  return Response.json({ error: "Only org owners or admin members can manage this" }, { status: 403 });
}

async function handleListPermissions(userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{
    id: string; principal: string; resource: string; access: string;
    label_filter: string | null; filter_lang: string | null; filter_expr: string | null;
    audit_reads: boolean; audit_writes: boolean; created_at: Date;
  }[]>`
    SELECT id, principal, resource, access, label_filter, filter_lang, filter_expr,
           audit_reads, audit_writes, created_at
    FROM common.permissions
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
  `;

  return Response.json({
    permissions: rows.map(r => ({
      id: r.id,
      principal: r.principal,
      resource: r.resource,
      access: r.access,
      labelFilter: r.label_filter,
      filterLang: r.filter_lang,
      filterExpr: r.filter_expr,
      auditReads: r.audit_reads,
      auditWrites: r.audit_writes,
      createdAt: r.created_at,
    })),
  });
}

async function handleCreatePermission(req: Request, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as {
    principal?: string; resource?: string; access?: string;
    labelFilter?: string; filterLang?: string; filterExpr?: string;
    auditReads?: boolean; auditWrites?: boolean;
  };

  const { principal, resource, access = "read", labelFilter = null, filterLang = null, filterExpr = null,
          auditReads = false, auditWrites = false } = body;

  if (!principal) return Response.json({ error: "principal is required" }, { status: 400 });
  if (!resource)  return Response.json({ error: "resource is required" }, { status: 400 });
  if (!["none", "read", "write", "admin"].includes(access))
    return Response.json({ error: "access must be none|read|write|admin" }, { status: 400 });
  if (filterLang && !["jq", "jmespath", "jsonata"].includes(filterLang))
    return Response.json({ error: "filterLang must be jq|jmespath|jsonata" }, { status: 400 });
  if (filterExpr && !filterLang)
    return Response.json({ error: "filterLang is required when filterExpr is set" }, { status: 400 });

  const [row] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO common.permissions
      (org_id, principal, resource, access, label_filter, filter_lang, filter_expr, audit_reads, audit_writes)
    VALUES
      (${orgId}, ${principal}, ${resource}, ${access}, ${labelFilter}, ${filterLang}, ${filterExpr},
       ${auditReads}, ${auditWrites})
    ON CONFLICT (principal, resource) DO UPDATE
      SET access       = EXCLUDED.access,
          label_filter = EXCLUDED.label_filter,
          filter_lang  = EXCLUDED.filter_lang,
          filter_expr  = EXCLUDED.filter_expr,
          audit_reads  = EXCLUDED.audit_reads,
          audit_writes = EXCLUDED.audit_writes
    RETURNING id, created_at
  `;

  return Response.json({
    id: row.id, principal, resource, access, labelFilter, filterLang, filterExpr,
    auditReads, auditWrites, createdAt: row.created_at,
  }, { status: 201 });
}

async function handleUpdatePermission(permId: string, req: Request, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as {
    access?: string; labelFilter?: string | null; filterLang?: string | null; filterExpr?: string | null;
    auditReads?: boolean; auditWrites?: boolean;
  };

  if (body.access && !["none", "read", "write", "admin"].includes(body.access))
    return Response.json({ error: "access must be none|read|write|admin" }, { status: 400 });
  if (body.filterLang && !["jq", "jmespath", "jsonata"].includes(body.filterLang))
    return Response.json({ error: "filterLang must be jq|jmespath|jsonata" }, { status: 400 });

  const rows = await sql<{ id: string; principal: string; resource: string; access: string;
    label_filter: string | null; filter_lang: string | null; filter_expr: string | null;
    audit_reads: boolean; audit_writes: boolean; created_at: Date }[]>`
    UPDATE common.permissions SET
      access       = COALESCE(${body.access ?? null}, access),
      label_filter = CASE WHEN ${("labelFilter" in body)} THEN ${body.labelFilter ?? null} ELSE label_filter END,
      filter_lang  = CASE WHEN ${("filterLang"  in body)} THEN ${body.filterLang  ?? null} ELSE filter_lang  END,
      filter_expr  = CASE WHEN ${("filterExpr"  in body)} THEN ${body.filterExpr  ?? null} ELSE filter_expr  END,
      audit_reads  = COALESCE(${body.auditReads  ?? null}, audit_reads),
      audit_writes = COALESCE(${body.auditWrites ?? null}, audit_writes)
    WHERE id = ${permId} AND org_id = ${orgId}
    RETURNING id, principal, resource, access, label_filter, filter_lang, filter_expr,
              audit_reads, audit_writes, created_at
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  const r = rows[0];
  return Response.json({
    id: r.id, principal: r.principal, resource: r.resource, access: r.access,
    labelFilter: r.label_filter, filterLang: r.filter_lang, filterExpr: r.filter_expr,
    auditReads: r.audit_reads, auditWrites: r.audit_writes, createdAt: r.created_at,
  });
}

async function handleDeletePermission(permId: string, userId: string, sessionId: string | null): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{ id: string }[]>`
    DELETE FROM common.permissions WHERE id = ${permId} AND org_id = ${orgId} RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: permId, deleted: true });
}

// -------------------------------------------------------
// Simple flat JSON diff
// -------------------------------------------------------

type DiffEntry = { op: "add" | "remove" | "replace"; path: string; value?: unknown; oldValue?: unknown };

function computeDiff(before: Record<string, unknown>, after: Record<string, unknown>): DiffEntry[] {
  const diff: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of allKeys) {
    const path = `/${key}`;
    const had = Object.hasOwn(before ?? {}, key);
    const has = Object.hasOwn(after ?? {}, key);
    if (!had && has) diff.push({ op: "add", path, value: after[key] });
    else if (had && !has) diff.push({ op: "remove", path, oldValue: before[key] });
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      diff.push({ op: "replace", path, value: after[key], oldValue: before[key] });
  }
  return diff;
}

export default server;

console.log(`Wren listening on http://localhost:${server.port}`);
console.log(`API docs available at http://localhost:${server.port}/docs`);
