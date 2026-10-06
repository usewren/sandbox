import postgres, { type Sql } from "postgres";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync, writeFileSync, renameSync, readdirSync, unlinkSync, appendFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { auth, sendMail, inviteMail, oAuthDiscoveryMetadata } from "auth";
import { setupCommon, createTenant, listTenants, migrateAllTenants, sanitizeSchemaName } from "db/runner";
import { startEvents, openStream, type Access } from "./events";
import * as retention from "./retention";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import Ajv from "ajv";
import { json as jqJson } from "jq-wasm";
import jmespath from "jmespath";
import jsonata from "jsonata";
import { handleMcp } from "./mcp";
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context. Set when an org admin's session impersonates a member, so
// every tenant transaction stamps its writes with the impersonating admin (see
// withTenant) and the request is audit-logged with both identities.
type RequestContext = { impersonatedBy?: string; audit?: { orgId: string; targetId: string }; mcpUser?: SessionUser };
const requestContext = new AsyncLocalStorage<RequestContext>();
// In-process requests made by MCP tools on behalf of a signed-in (OAuth) MCP user.
// Only Request objects created by the server itself can carry that identity.
const internalRequests = new WeakSet<Request>();

const WREN_VERSION = "0.10.2";
// Set at image build time: docker build --build-arg WREN_BUILD=$(git rev-parse --short HEAD) …
const WREN_BUILD = process.env.WREN_BUILD?.trim() || "dev";

// ── Crash-resilient logging ──────────────────────────────────────────────────
// Ring buffer: keeps the last 5 minutes of logs on disk. On startup, preserves
// the previous run's log as a crash log for debugging.

const LOG_DIR = process.env.WREN_LOG_DIR ?? "/data";
const LOG_FILE = join(LOG_DIR, "wren.log");
const LOG_RING_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CRASH_LOGS = 3;

// In-memory ring buffer — flushed to disk every second
const logRing: { ts: number; msg: string }[] = [];

function wlog(msg: string) {
  const now = Date.now();
  const line = `[${new Date(now).toISOString()}] ${msg}`;
  logRing.push({ ts: now, msg: line });
  // Trim entries older than 5 minutes
  const cutoff = now - LOG_RING_MS;
  while (logRing.length > 0 && logRing[0].ts < cutoff) logRing.shift();
  // Also write to stdout
  console.log(msg);
}

function flushLogRing() {
  if (logRing.length === 0) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const content = logRing.map(e => e.msg).join("\n") + "\n";
    writeFileSync(LOG_FILE, content);
  } catch { /* disk might not be writable in all environments */ }
}

function preserveCrashLog() {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stat = Bun.file(LOG_FILE);
    if (stat.size === 0) return;

    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const crashFile = join(LOG_DIR, `wren-crash-${ts}.log`);
    renameSync(LOG_FILE, crashFile);
    console.log(`[boot] Preserved previous log as ${crashFile}`);

    // Keep only the last N crash logs
    const crashLogs = readdirSync(LOG_DIR)
      .filter(f => f.startsWith("wren-crash-") && f.endsWith(".log"))
      .sort()
      .reverse();
    for (const old of crashLogs.slice(MAX_CRASH_LOGS)) {
      try { unlinkSync(join(LOG_DIR, old)); } catch { /* ignore */ }
    }
  } catch { /* first run, no log dir, etc. */ }
}

// Preserve crash log from previous run before anything else
preserveCrashLog();

// Flush ring buffer to disk every second
setInterval(flushLogRing, 1000);

// Catch unhandled errors — log them before dying
process.on("uncaughtException", (err) => {
  wlog(`FATAL uncaughtException: ${err.stack ?? err.message ?? err}`);
  flushLogRing();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  wlog(`FATAL unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  flushLogRing();
  process.exit(1);
});

const ajv = new Ajv({ allErrors: true });

// Plain-JS admin UI — served directly (no build step) from public/admin/
const ADMIN_DIR = join(import.meta.dir, "public", "admin");
const ADMIN_INDEX = join(ADMIN_DIR, "index.html");

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

const MARKETING_DIR = join(import.meta.dir, "public", "marketing");

// Guide pages live in marketing/guides/{slug}.html; "index" is the /guides landing page.
function listGuideSlugs(): string[] {
  try {
    return readdirSync(join(MARKETING_DIR, "guides"))
      .filter(f => /^[a-z0-9-]+\.html$/.test(f) && f !== "index.html")
      .map(f => f.replace(/\.html$/, ""))
      .sort();
  } catch { return []; }
}

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

// Base URL for links we hand out (projects, llms.txt, sitemap, robots). Behind a
// TLS-terminating proxy (e.g. Cloudflare Tunnel) the request URL is http://, so
// prefer the configured public URL.
function publicBase(url: URL): string {
  const configured = (process.env.WREN_URL || process.env.BETTER_AUTH_URL || "").replace(/\r/g, "").trim().replace(/\/$/, "");
  return configured || `${url.protocol}//${url.host}`;
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  // Never let a CDN keep serving a 404/403 after the content is published.
  if (!res.ok) res.headers.set("Cache-Control", "no-store");
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

const sql = postgres(process.env.DATABASE_URL ?? "postgres://wren:wren@localhost:5432/wren");

// Set up common schema and warm the known-tenant cache at startup
await setupCommon(sql);
await migrateAllTenants(sql);
// Retention policies run hourly for every org that has one
retention.scheduleRetention(sql, withTenant, sanitizeSchemaName);

// Change feed: committed writes in any tenant → event streams and webhooks
await startEvents(sql, async (orgId, change) => {
  if (!(await orgHasWebhooks(orgId))) return;
  const { type, at: _at, ...payload } = change;
  emitWebhookEvent(orgId, type, payload).catch(() => {});
});
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
// Landing-page experiment — "/" serves one variant per visitor
// -------------------------------------------------------
// Each new visitor gets a random variant, kept in the wren_v cookie (the variant
// letter only, no identifier). Counts are aggregated per day/variant/event: no
// IPs, no user ids. /a … /e always serve a fixed variant and aren't counted.
// WREN_LANDING_VARIANTS=c turns the experiment off (everyone gets c, no cookie).
const LANDING_FILES: Record<string, string> = {
  a: "index.html", b: "trees.html", c: "combined.html", d: "deploy.html", e: "ai.html",
};
const LANDING_VARIANTS = (() => {
  const v = (process.env.WREN_LANDING_VARIANTS ?? "a,b,c,d,e").split(",").map(s => s.trim()).filter(s => s in LANDING_FILES);
  return v.length ? v : ["c"];
})();
const LANDING_DEFAULT = LANDING_VARIANTS.includes("c") ? "c" : LANDING_VARIANTS[0];
const LANDING_EVENTS = ["visitor", "view", "admin", "signup"] as const;
type LandingEvent = typeof LANDING_EVENTS[number];
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|httpx|go-http|headless|monitor|uptime|lighthouse/i;
const landingCounts = new Map<string, number>(); // "variant|event" → count since last flush

function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** The visitor's variant if they are in the experiment (a cookie we assigned). */
function landingVariantOf(req: Request): string | null {
  const v = readCookie(req, "wren_v");
  return v && LANDING_VARIANTS.length > 1 && LANDING_VARIANTS.includes(v) ? v : null;
}

function countLanding(variant: string, event: LandingEvent): void {
  const key = `${variant}|${event}`;
  landingCounts.set(key, (landingCounts.get(key) ?? 0) + 1);
}

function landingCookie(req: Request, name: string, value: string): string {
  const secure = req.url.startsWith("https://") || req.headers.get("x-forwarded-proto") === "https";
  return `${name}=${value}; Path=/; Max-Age=${90 * 86400}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
}

async function flushLandingStats(): Promise<void> {
  if (landingCounts.size === 0) return;
  const entries = Array.from(landingCounts.entries());
  landingCounts.clear();
  const today = new Date().toISOString().split("T")[0];
  await Promise.all(entries.map(([key, n]) => {
    const [variant, event] = key.split("|");
    return sql`
      INSERT INTO common.landing_stats (date, variant, event, count)
      VALUES (${today}, ${variant}, ${event}, ${n})
      ON CONFLICT (date, variant, event) DO UPDATE SET count = common.landing_stats.count + EXCLUDED.count
    `.catch(() => {});
  }));
}

setInterval(flushLandingStats, 60_000);

function serveLanding(req: Request): Response {
  const headers: Record<string, string> = { "Content-Type": "text/html", ...NO_CACHE, Vary: "Cookie" };
  const ua = req.headers.get("user-agent") ?? "";
  let variant = landingVariantOf(req);
  if (LANDING_VARIANTS.length < 2 || !ua || BOT_UA.test(ua)) {
    variant = variant ?? LANDING_DEFAULT; // crawlers always see the default, uncounted
  } else {
    if (!variant) {
      variant = LANDING_VARIANTS[Math.floor(Math.random() * LANDING_VARIANTS.length)];
      headers["Set-Cookie"] = landingCookie(req, "wren_v", variant);
      countLanding(variant, "visitor");
    }
    countLanding(variant, "view");
  }
  return new Response(Bun.file(join(import.meta.dir, "public", "marketing", LANDING_FILES[variant])), { headers });
}

/** GET /api/v1/landing-stats?days=30 — server operators only (WREN_OPERATORS emails). */
async function handleLandingStats(url: URL): Promise<Response> {
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
  await flushLandingStats();
  const rows = await sql<{ variant: string; event: string; count: string; since: string | null }[]>`
    SELECT variant, event, SUM(count)::bigint AS count, MIN(date)::text AS since
    FROM common.landing_stats
    WHERE date > CURRENT_DATE - ${days}::int
    GROUP BY variant, event
  `;
  const variants = Object.keys(LANDING_FILES).map(v => {
    const counts = Object.fromEntries(LANDING_EVENTS.map(e => [e, 0])) as Record<LandingEvent, number>;
    for (const r of rows) if (r.variant === v && (LANDING_EVENTS as readonly string[]).includes(r.event)) counts[r.event as LandingEvent] = Number(r.count);
    return { variant: v, file: LANDING_FILES[v], active: LANDING_VARIANTS.includes(v), ...counts };
  });
  const since = rows.map(r => r.since).filter(Boolean).sort()[0] ?? null;
  return Response.json({ days, since, variants });
}

const OPERATORS = new Set((process.env.WREN_OPERATORS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

// Webhook constants (must be before setInterval references)
const WEBHOOK_BATCH_WINDOW_MS = Number(process.env.WEBHOOK_BATCH_WINDOW_MS ?? "5000");
const WEBHOOK_MAX_RETRIES = 5;
const WEBHOOK_DISABLE_THRESHOLD = 10;
const WEBHOOK_MAX_PER_ORG = 10;
const pendingWebhookBatches = new Map<string, { orgId: string; events: { type: string; payload: unknown }[] }>();

// Guard: don't overlap batch processing (delivery retries can take 30s+)
let webhookProcessing = false;
setInterval(async () => {
  if (webhookProcessing) return;
  webhookProcessing = true;
  try { await processWebhookBatches(); }
  catch (e) { wlog(`[webhook] batch processing error: ${e}`); }
  finally { webhookProcessing = false; }
}, WEBHOOK_BATCH_WINDOW_MS);

setInterval(() => {
  purgeOldWebhookData().catch(e => wlog(`[webhook] purge error: ${e}`));
}, 86_400_000);

// Delay recovery until after the server is listening (DB might not be ready yet)
setTimeout(() => {
  recoverPendingWebhookBatches().catch(e => wlog(`[webhook] recovery failed: ${e}`));
}, 5000);

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
    // Impersonated request: column defaults on versions/labels/paths record the admin
    // (tenant migration 012). Transaction-local, passed as a parameter.
    const impersonatedBy = requestContext.getStore()?.impersonatedBy;
    if (impersonatedBy) await tx`SELECT set_config('wren.impersonated_by', ${impersonatedBy}, true)`;
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

// Public (no-auth) routes: /orgs/{slug}/..., /api/v1/orgs/{slug}/..., /api/v1/projects.
// These never honour credentials, so any origin may read them.
function isPublicPath(pathname: string): boolean {
  return pathname.startsWith("/orgs/") || pathname.startsWith("/api/v1/orgs/") || pathname === "/api/v1/projects";
}

/** Origins that may use the session cookie: configured ones, and the server's own site. */
function isTrustedOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Same-site: if the Origin's host matches the request Host header, always allow.
  // This covers Cloudflare Tunnel and any reverse proxy without needing env vars.
  try { return !!host && new URL(origin).host === host; } catch { return false; }
}

function corsHeaders(origin: string | null, host: string | null, pathname: string): Record<string, string> {
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Cookie, Authorization, If-Match",
    "Access-Control-Expose-Headers": "ETag",
  };
  const trusted = isTrustedOrigin(origin, host);
  // Public routes: always "*" regardless of Origin, so a CDN-cached response is valid
  // for every site. Same-origin pages don't need CORS at all.
  if (isPublicPath(pathname)) return { ...base, "Access-Control-Allow-Origin": "*" };
  // Trusted origins may use the session cookie.
  if (trusted) return { ...base, "Access-Control-Allow-Origin": origin!, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" };
  // Any other origin may call the data API with an explicit Bearer key, but never with
  // cookies (no Allow-Credentials), so a foreign page can't ride a logged-in session.
  if (origin && pathname.startsWith("/api/v1/")) return { ...base, "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  return { ...base, "Access-Control-Allow-Origin": "" };
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

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
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

// keyOrgId pins the org for the request: the key's org, or the org an admin is
// impersonating in. `impersonator` is set while an admin acts as this user.
type SessionUser = {
  userId: string; name: string; email: string; sessionId: string | null; keyId?: string; keyOrgId?: string;
  impersonator?: { userId: string; name: string; email: string; expiresAt: Date };
};

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
  // An MCP tool call from a signed-in MCP connection (/mcp/login): the identity was
  // established from the OAuth token and is only honoured for internal requests.
  const ctx = requestContext.getStore();
  if (ctx?.mcpUser && internalRequests.has(req)) return ctx.mcpUser;
  const apiKey = await checkApiKey(req);
  if (apiKey) return apiKey;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;

  // An org admin's session may be impersonating a member of that org: the request
  // then acts as the member, pinned to that org (never the member's own or other orgs).
  const [imp] = await sql<{ org_id: string; target_user_id: string; expires_at: Date; name: string; email: string }[]>`
    SELECT i.org_id, i.target_user_id, i.expires_at, u.name, u.email
    FROM common.impersonations i JOIN "user" u ON u.id = i.target_user_id
    WHERE i.session_id = ${session.session.id} AND i.ended_at IS NULL AND i.expires_at > NOW()
  `;
  if (imp) {
    const ctx = requestContext.getStore();
    if (ctx) { ctx.impersonatedBy = session.user.id; ctx.audit = { orgId: imp.org_id, targetId: imp.target_user_id }; }
    return {
      userId: imp.target_user_id, name: imp.name, email: imp.email,
      sessionId: session.session.id, keyOrgId: imp.org_id,
      impersonator: { userId: session.user.id, name: session.user.name, email: session.user.email, expiresAt: imp.expires_at },
    };
  }
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
  // Org owners bypass all permission checks — except through a key that has rules of
  // its own: those narrow it, for the owner's keys as for anyone's.
  if (userId === orgId && !(principal.startsWith("key:") && await keyHasOwnRules(orgId, principal))) {
    return { allowed: true, auditReads: false, auditWrites: false };
  }

  const [type] = resource.split(":");
  const categoryWild = `${type}:*`;

  const principals = await effectivePrincipals(orgId, userId, principal);
  if (!principals.length) return { allowed: false, auditReads: false, auditWrites: false };

  // Most specific resource first; at equal specificity a personal (member/key) rule
  // beats a group rule, so an individual exception wins; among groups the highest
  // access wins (a person in Viewers and Editors can write).
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
      AND principal = ANY(${principals})
      AND resource = ANY(ARRAY[${resource}, ${categoryWild}, '*'])
    ORDER BY CASE resource
        WHEN ${resource}      THEN 0
        WHEN ${categoryWild}  THEN 1
        ELSE 2
      END,
      CASE WHEN principal LIKE 'group:%' THEN 1 ELSE 0 END,
      CASE access WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC
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

/** Whether a key has rules of its own in this org (which narrow it). */
async function keyHasOwnRules(orgId: string, principal: string): Promise<boolean> {
  const own = await sql<{ x: number }[]>`
    SELECT 1 AS x FROM common.permissions WHERE org_id = ${orgId} AND principal = ${principal} LIMIT 1
  `;
  return own.length > 0;
}

// Principals whose permission rules apply to a caller in an org:
//   '*'                      → just '*' (public reads)
//   member:<uid>             → that member + their groups in the org
//   key:<id> with own rules  → just the key (rules on a key narrow it)
//   key:<id> without rules   → acts as the person who created it (member + groups)
// (The owner's own keys only get here when they have rules of their own.)
// Callers who aren't (or no longer are) members of the org get nothing, so a
// removed member's old keys stop working. The owner always counts as a member.
async function effectivePrincipals(orgId: string, userId: string, principal: string): Promise<string[]> {
  if (principal === "*" || !userId) return [principal];
  const member = userId === orgId || (await sql<{ x: number }[]>`
    SELECT 1 AS x FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${userId}
  `).length > 0;
  if (!member) return [];
  if (principal.startsWith("key:") && await keyHasOwnRules(orgId, principal)) return [principal];
  const groups = await sql<{ id: string }[]>`
    SELECT g.id FROM common.groups g JOIN common.group_members gm ON gm.group_id = g.id
    WHERE g.org_id = ${orgId} AND gm.user_id = ${userId}
  `;
  return [`member:${userId}`, ...groups.map(g => `group:${g.id}`)];
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

/** Why a filter expression can't be used, or null. Checked when a rule is saved, so a
 *  typo doesn't silently turn every read under the rule into null. */
async function filterExprError(lang: string, expr: string): Promise<string | null> {
  try {
    if (lang === "jmespath") jmespath.compile(expr);
    else if (lang === "jsonata") jsonata(expr);
    else if (lang === "jq") {
      // jq has no separate compile step: run it on {} and only count compile errors
      try { await jqJson({}, expr); }
      catch (e) { if (/compile|syntax/i.test(String(e))) throw e; }
    }
    return null;
  } catch (e) {
    return `filterExpr is not valid ${lang}: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
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
    const cors = corsHeaders(origin, req.headers.get("host"), url.pathname);

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

    const ctx: RequestContext = {};
    let res = await requestContext.run(ctx, () => handleRequest(effectiveReq, url)).catch(errorResponse);
    // Every request made while impersonating is audit-logged with both identities
    if (ctx.audit && ctx.impersonatedBy) {
      logAccess(ctx.audit.orgId, `member:${ctx.audit.targetId}`, `impersonated-by:${ctx.impersonatedBy}`, req.method, url.pathname, res.status);
    }
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

    for (const [k, v] of Object.entries(cors)) {
      // Merge Vary instead of replacing it: content-negotiated responses rely on Vary: Accept.
      if (k === "Vary" && res.headers.has("Vary")) res.headers.set("Vary", `${res.headers.get("Vary")}, ${v}`);
      else res.headers.set(k, v);
    }
    // Authenticated responses must never be stored by a shared cache: Cloudflare caches
    // static extensions (.js, .css, .png…) by default, so a private file fetched with a
    // key could otherwise be served to anonymous visitors from the edge.
    if (url.pathname.startsWith("/api/v1/") && !isPublicPath(url.pathname)) {
      res.headers.set("Cache-Control", "private, no-store");
    }
    return res;
  },
});

/** Escape LIKE wildcards so "_" and "%" in a path match themselves. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** Thrown from deep inside a handler (e.g. a transaction) to answer with this status. */
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Errors no handler turned into a response. A body that isn't valid JSON (from
// `await req.json()` in any handler) is the client's mistake; anything else is ours.
function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof SyntaxError) return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  console.error("[unhandled]", err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

async function handleRequest(req: Request, url: URL): Promise<Response> {

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: WREN_VERSION, build: WREN_BUILD });
    }


    // WREN logo — served from public directory (no auth required)
    // wren.js — client-side web components library for declarative data binding
    if (url.pathname === "/wren.js") {
      return new Response(Bun.file(join(import.meta.dir, "public", "wren.js")), {
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

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

    // Marketing site — "/" serves one landing variant per visitor (see serveLanding);
    // /a … /e always show one variant, for reviewing and sharing.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveLanding(req);
    }
    // A/B variant E — AI-agents-first landing
    if (url.pathname === "/e" || url.pathname === "/e.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "ai.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    // Landing experiment results (the data comes from /api/v1/landing-stats)
    if (url.pathname === "/stats/landing") {
      return new Response(Bun.file(join(import.meta.dir, "public", "landing-stats.html")), {
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

    // Concepts page and guides (how-tos, case studies): static HTML, no JS required
    if (url.pathname === "/guides.css") {
      return new Response(Bun.file(join(MARKETING_DIR, "guides.css")), {
        headers: { "Content-Type": "text/css", ...NO_CACHE },
      });
    }
    if ((url.pathname === "/concepts" || url.pathname === "/concepts.html") && existsSync(join(MARKETING_DIR, "concepts.html"))) {
      return new Response(Bun.file(join(MARKETING_DIR, "concepts.html")), {
        headers: { "Content-Type": "text/html", ...NO_CACHE },
      });
    }
    if (url.pathname === "/guides" || url.pathname === "/guides/" || url.pathname.startsWith("/guides/")) {
      const slug = url.pathname.replace(/^\/guides\/?/, "").replace(/\.html$/, "").replace(/\/$/, "") || "index";
      const file = join(MARKETING_DIR, "guides", `${slug}.html`);
      if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) {
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(Bun.file(file), { headers: { "Content-Type": "text/html", ...NO_CACHE } });
    }

    // LLM / crawler discovery files
    if (url.pathname === "/robots.txt") {
      const base = publicBase(url);
      return new Response(
        `User-agent: *\nAllow: /\n\n# AI crawlers — welcome\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: anthropic-ai\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    if (url.pathname === "/sitemap.xml") {
      const base = publicBase(url);
      const now = new Date().toISOString().split("T")[0];
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${base}/</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/a</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/b</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/c</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/tutorial</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/tutorial/trees</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/tutorial/deploy</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/d</loc><lastmod>${now}</lastmod><priority>1.0</priority></url>\n  <url><loc>${base}/docs</loc><lastmod>${now}</lastmod><priority>0.8</priority></url>\n  <url><loc>${base}/projects</loc><lastmod>${now}</lastmod><priority>0.8</priority></url>\n  <url><loc>${base}/llms.txt</loc><lastmod>${now}</lastmod><priority>0.7</priority></url>\n  <url><loc>${base}/concepts</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n  <url><loc>${base}/guides</loc><lastmod>${now}</lastmod><priority>0.9</priority></url>\n${listGuideSlugs().map(s => `  <url><loc>${base}/guides/${s}</loc><lastmod>${now}</lastmod><priority>0.8</priority></url>\n`).join("")}</urlset>`,
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
      const res = serveAdminFile(filePath) ?? serveAdminIndex();
      // Landing experiment: count the first Admin UI open per visitor
      const variant = filePath === ADMIN_INDEX ? landingVariantOf(req) : null;
      if (variant && !readCookie(req, "wren_va")) {
        countLanding(variant, "admin");
        res.headers.append("Set-Cookie", landingCookie(req, "wren_va", "1"));
      }
      return res;
    }

    // The old React admin UI is gone; send old bookmarks to the current one
    if (url.pathname === "/oldadmin" || url.pathname.startsWith("/oldadmin/")) {
      return new Response(null, { status: 301, headers: { Location: "/admin/" } });
    }

    // Auth routes — handled by Better Auth
    // Cloudflare Tunnel (and other reverse proxies) terminate TLS and forward
    // plain HTTP. Better Auth auto-detects its origin from the request URL, so
    // it sees http:// while the browser sends Origin: https://. Rewrite the
    // request URL to match the real protocol so origin validation succeeds.
    // MCP OAuth: always show WREN's consent page. Better Auth only asks for consent
    // when the client sends prompt=consent; MCP clients register themselves, so
    // auto-approval would hand a signed-in user's token to any registered client.
    if (url.pathname === "/api/auth/mcp/authorize" && url.searchParams.get("prompt") !== "consent") {
      const forced = new URL(url);
      forced.searchParams.set("prompt", "consent");
      return Response.redirect(`${forced.pathname}${forced.search}`, 302);
    }

    if (url.pathname.startsWith("/api/auth")) {
      // Cookie-based auth actions (sign-in, sign-out, password change…) only from our own
      // site or configured origins, so another site can't trigger them in a visitor's
      // browser. OAuth token and client registration don't use cookies; apps call them.
      const origin = req.headers.get("origin");
      if (req.method === "POST" && origin && !isTrustedOrigin(origin, req.headers.get("host"))
          && url.pathname !== "/api/auth/mcp/token" && url.pathname !== "/api/auth/mcp/register") {
        return Response.json({ error: "Origin not allowed" }, { status: 403 });
      }
      const proto = req.headers.get("x-forwarded-proto");
      const authReq = proto === "https" && !req.url.startsWith("https://")
        ? new Request(req.url.replace(/^http:/, "https:"), {
            method: req.method,
            headers: req.headers,
            body: req.body,
            // @ts-ignore — Bun supports duplex
            duplex: "half",
          })
        : req;
      const res = await auth.handler(authReq);
      // Landing experiment: a successful email sign-up counts for the visitor's variant
      if (url.pathname === "/api/auth/sign-up/email" && req.method === "POST" && res.ok) {
        const variant = landingVariantOf(req);
        if (variant) countLanding(variant, "signup");
      }
      return res;
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

    // Org-bound MCP endpoint: /orgs/{slug}/mcp — what a custom domain's /mcp maps to.
    // Without a key: public read-only tools (optionally ?tree=&collections=).
    // With a key: full tools, only for keys of this org.
    const orgMcp = url.pathname.match(/^\/orgs\/([a-z0-9-]+)\/mcp$/);
    if (orgMcp) {
      if (!(await resolveSlugToOrgId(orgMcp[1]))) return Response.json({ error: "Not found" }, { status: 404 });
      return handleMcp(req, url, r => handleRequest(r, new URL(r.url)), WREN_VERSION, { slug: orgMcp[1] });
    }

    // Clean public URLs: /orgs/{slug}/... — alias for /api/v1/orgs/{slug}/...
    // Allows tree paths like /orgs/tkd/tree/site/index.html to open directly in a browser.
    if (req.method === "GET" && url.pathname.startsWith("/orgs/")) {
      const parts = url.pathname.slice("/orgs/".length).split("/");
      const [slug, ...rest] = parts;
      if (slug && rest.length > 0) {
        const sub = rest[0];
        if (sub === "wren.js") {
          return new Response(Bun.file(join(import.meta.dir, "public", "wren.js")), {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
          });
        }
        if (sub === "llms.txt") {
          const optionalUser = await requireSession(req);
          return handleOrgLlmsTxt(slug, url, optionalUser);
        }
        if (sub === "_events" && rest.length === 1) return handlePublicEvents(slug, req, url);
        // Pass everything after /orgs/{slug}/ to the public collection/tree handler
        const collection = rest[0];
        const id = rest[1];
        const subSeg = rest[2];
        return handlePublicCollectionRequest(slug, collection, id, subSeg, url, req.headers.get("accept"), req, rest[3]);
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // MCP endpoint for AI agents: one per instance, org comes from the API key.
    // Tools call this same handler in-process, so all permission checks apply.
    if (url.pathname === "/mcp") {
      return handleMcp(req, url, r => handleRequest(r, new URL(r.url)), WREN_VERSION);
    }

    // MCP with browser sign-in (OAuth). Same tools as /mcp with a key; the org is the
    // one the user picked on the consent page for this client.
    if (url.pathname === "/mcp/login") return handleMcpLogin(req, url);
    if (url.pathname === "/mcp/consent" && req.method === "GET") {
      return new Response(Bun.file(join(import.meta.dir, "public", "mcp-consent.html")), { headers: { "Content-Type": "text/html", ...NO_CACHE } });
    }
    if (url.pathname === "/mcp/consent/info" && req.method === "GET") return handleMcpConsentInfo(req, url);
    if (url.pathname === "/mcp/consent/approve" && req.method === "POST") return handleMcpConsentApprove(req);

    // OAuth discovery for MCP clients (RFC 8414 / RFC 9728)
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/oauth-authorization-server/api/auth") {
      return oAuthDiscoveryMetadata(auth)(req);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp/login") {
      return Response.json(mcpProtectedResource(url), { headers: { "Cache-Control": "public, max-age=300" } });
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
      // Allow GET + POST (POST is needed for public _query)
      if (req.method !== "GET" && req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
      const optionalUser = await requireSession(req); // null = unauthenticated
      if (sub === "llms.txt") return handleOrgLlmsTxt(id, url, optionalUser);
      if (sub === "_events" && !version && req.method === "GET") return handlePublicEvents(id, req, url);
      if (sub) return handlePublicCollectionRequest(id, sub, version, subsub, url, req.headers.get("accept"), req, segments[5]);
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // All other routes require authentication
    const user = await requireSession(req);
    if (!user) return unauthorized();

    // Impersonation status / end — /api/v1/impersonation
    if (collection === "impersonation" && !id) {
      if (req.method === "GET")    return Response.json({ impersonating: impersonationInfo(user) });
      if (req.method === "DELETE") return handleEndImpersonation(user);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    // While impersonating, the admin acts as the member on data only: no org
    // management, and nothing that would reveal the member's other orgs.
    if (user.impersonator && ["keys", "permissions", "invites", "members", "groups", "webhooks", "org", "connected-apps", "retention"].includes(collection)) {
      return Response.json({ error: "Not available while impersonating. End impersonation first." }, { status: 403 });
    }

    // Landing experiment results — server operators (WREN_OPERATORS) in their own browser session
    if (collection === "landing-stats" && req.method === "GET") {
      if (!user.sessionId || user.keyId || user.impersonator || !OPERATORS.has(user.email.toLowerCase())) {
        return Response.json({ error: "Only server operators (WREN_OPERATORS) can see landing stats" }, { status: 403 });
      }
      return handleLandingStats(url);
    }

    // Connected apps (MCP sign-ins) — /api/v1/connected-apps[/:clientId]
    // A person's own browser session only: not API keys, not MCP tokens.
    if (collection === "connected-apps") {
      if (!user.sessionId || user.keyId) return Response.json({ error: "Sign in with a browser session to manage connected apps" }, { status: 403 });
      if (req.method === "GET"    && !id) return handleListConnectedApps(user);
      if (req.method === "DELETE" && id)  return handleRevokeConnectedApp(id, user);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

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
      if (req.method === "GET") return handleGetOrg(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "PUT") return handleSwitchOrg(req, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (collection === "org" && id === "slug" && !sub) {
      if (req.method === "PUT") return handleSetOrgSlug(req, user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (collection === "org" && id === "usage" && !sub) {
      if (req.method === "GET") return handleGetOrgUsage(user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Invite management routes — /api/v1/invites[/:inviteId | /accept | /received]
    if (collection === "invites") {
      if (req.method === "GET"    && !id)               return handleListInvites(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "GET"    && id === "received")  return handleListReceivedInvites(user);
      if (req.method === "POST"   && !id)               return handleCreateInvite(req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && id === "accept")   return handleAcceptInvite(req, user.userId);
      if (req.method === "POST"   && sub === "accept")  return handleAcceptInviteById(id, user);
      if (req.method === "DELETE" && id)                return handleRevokeInvite(id, user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Member management routes — /api/v1/members[/:memberId]
    if (collection === "members") {
      if (req.method === "GET"    && !id) return handleListMembers(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "DELETE" && id && !sub)  return handleRemoveMember(id, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && id && sub === "impersonate") return handleStartImpersonation(id, user);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Groups — /api/v1/groups[/:id[/members/:userId]]
    if (collection === "groups") {
      const memberId = segments[3];
      if (req.method === "GET"    && !id)           return handleListGroups(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && !id)           return handleCreateGroup(req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "PUT"    && id && !sub)    return handleUpdateGroup(id, req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "DELETE" && id && !sub)    return handleDeleteGroup(id, user.userId, user.sessionId, user.keyOrgId);
      if (id && sub === "members" && memberId && (req.method === "PUT" || req.method === "DELETE"))
        return handleGroupMember(id, memberId, req.method === "PUT", user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Permission management routes — /api/v1/permissions[/:permissionId]
    if (collection === "permissions") {
      if (req.method === "GET"    && !id)  return handleListPermissions(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && !id)  return handleCreatePermission(req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "PUT"    && id)   return handleUpdatePermission(id, req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "DELETE" && id)   return handleDeletePermission(id, user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Retention policies — /api/v1/retention[/{collection|*}[/_preview] | /_apply]
    if (collection === "retention") {
      if (req.method === "GET"    && !id)                      return handleGetRetention(user);
      if (req.method === "POST"   && id === "_apply" && !sub)  return handleApplyRetention(user);
      if (req.method === "PUT"    && id && !sub)               return handleSetRetention(id, req, user);
      if (req.method === "DELETE" && id && !sub)               return handleDeleteRetention(id, user);
      if (req.method === "POST"   && id && sub === "_preview") return handlePreviewRetention(id, req, user);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Webhook management routes — /api/v1/webhooks[/:id[/deliveries|/replay]]
    if (collection === "webhooks") {
      if (req.method === "GET"    && !id)                        return handleListWebhooks(user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && !id)                        return handleCreateWebhook(req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "PUT"    && id && !sub)                 return handleUpdateWebhook(id, req, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "DELETE" && id && !sub)                 return handleDeleteWebhook(id, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "GET"    && id && sub === "deliveries") return handleGetWebhookDeliveries(id, user.userId, user.sessionId, user.keyOrgId);
      if (req.method === "POST"   && id && sub === "replay")     return handleReplayWebhook(id, req, user.userId, user.sessionId, user.keyOrgId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Resolve org — split into orgId + schemaName so access checks can use orgId
    const orgId = await resolveUserOrgId(user.userId, user.sessionId, user.keyOrgId);
    const schemaName = await ensureTenant(orgId);
    const principal = principalFor(user);

    // Live changes you can read in this org — GET /api/v1/_events (Server-Sent Events)
    if (collection === "_events" && !id && req.method === "GET") {
      keepOpen(req);
      return openStream(req, url, orgId, resource => checkAccess(orgId, user.userId, principal, resource, "read"));
    }

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
      else if (req.method === "POST" && treePath === "/_promote") {
        // Moving a label is a write on every collection whose documents are in the tree.
        const canWrite = async (col: string) =>
          (await checkAccess(orgId, user.userId, principal, `collection:${col}`, "write")).allowed;
        treeRes = await handleTreePromote(schemaName, treeName, req, user.userId, canWrite);
        if (treeRes.status < 400) {
          const { promoted } = await treeRes.clone().json() as { promoted: { path: string; documentId: string; collection: string }[] };
          for (const p of promoted) {
            purgeForTreePath(orgId, treeName, p.path).catch(() => {});
            purgeForDocument(orgId, p.collection, p.documentId).catch(() => {});
          }
        }
      }
      else if (req.method === "POST" && treePath === "/_restore") {
        // Restoring rewrites documents in every collection in the tree: need write on each
        const cols = await withTenant(schemaName, tx => tx<{ collection: string }[]>`
          SELECT DISTINCT d.collection FROM paths p JOIN documents d ON d.id = p.document_id
          WHERE p.tree = ${treeName}
        `);
        const denied: string[] = [];
        for (const { collection: col } of cols) {
          if (!(await checkAccess(orgId, user.userId, principal, `collection:${col}`, "write")).allowed) denied.push(col);
        }
        if (denied.length) {
          treeRes = Response.json({ error: "Restoring this tree needs write access to every collection in it", collections: denied }, { status: 403 });
        } else {
          const out = await restoreToLabel(schemaName, { tree: treeName }, req, user.userId);
          if ("error" in out) treeRes = out.error;
          else {
            treeRes = Response.json({ tree: treeName, ...out.result });
            const paths = await withTenant(schemaName, tx => tx<{ path: string }[]>`SELECT path FROM paths WHERE tree = ${treeName}`);
            for (const p of paths) purgeForTreePath(orgId, treeName, p.path).catch(() => {});
            for (const col of out.result.collections) {
              purgeForCollection(orgId, col).catch(() => {});
              refreshMaterializedForCollection(schemaName, col, user.userId).catch(() => {});
            }
          }
        }
      }
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
    if (id === "_query" && (req.method === "POST" || req.method === "GET")) {
      reqAccess = "read"; // queries are read-only
    } else if (id === "_materialized") {
      reqAccess = req.method === "GET" ? "read" : "admin";
    } else if (id === "_schema" && sub === "validate") {
      reqAccess = "read";
    } else if (id === "_schema" && req.method !== "GET") { // PUT, PATCH, DELETE
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
      let res = await handleList(schemaName, collection, url, user.userId, colAr.labelFilter);
      res = await withRefResolution(res, schemaName, url, colAr.labelFilter, resource => checkAccess(orgId, user.userId, principal, resource, "read"));
      audit(colAr, colResource, true, res.status);
      return filterResponse(res, colAr);
    }

    // Route: POST /{collection}/_restore {label, deleteUnlabeled?} — whole collection to a label
    if (req.method === "POST" && id === "_restore" && !sub) {
      const out = await restoreToLabel(schemaName, { collection }, req, user.userId);
      if ("error" in out) { audit(colAr, colResource, false, out.error.status); return out.error; }
      audit(colAr, colResource, false, 200);
      purgeForCollection(orgId, collection).catch(() => {});
      refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
      return Response.json(out.result);
    }

    // Schema routes: GET|PUT|DELETE /{collection}/_schema
    if (id === "_schema" && !sub) {
      if (req.method === "GET")    { const r = await handleGetSchema(schemaName, collection);    audit(colAr, colResource, true, r.status);  return r; }
      if (req.method === "PUT")    { const r = await handleSetSchema(schemaName, collection, req, user.userId); audit(colAr, colResource, false, r.status); return r; }
      if (req.method === "PATCH")  { const r = await handlePatchSchema(schemaName, collection, req, user.userId); audit(colAr, colResource, false, r.status); return r; }
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

    // Query endpoint: POST /{collection}/_query
    // Filter + projection + aggregation in one call. Replaces the hand-built
    // index-doc pattern.
    if (id === "_query" && !sub && (req.method === "POST" || req.method === "GET")) {
      const r = await handleQuery(schemaName, collection, req, colAr);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Materialized queries: persisted query results that auto-refresh on write
    if (id === "_materialized") {
      if (req.method === "GET" && !sub) {
        const r = await handleListMaterialized(schemaName, collection);
        audit(colAr, colResource, true, r.status);
        return r;
      }
      if (req.method === "GET" && sub) {
        const r = await handleGetMaterialized(schemaName, collection, sub);
        audit(colAr, colResource, true, r.status);
        return filterResponse(r, colAr);
      }
      if (req.method === "PUT" && sub) {
        const r = await handleSetMaterialized(schemaName, collection, sub, req, user.userId);
        audit(colAr, colResource, false, r.status);
        return r;
      }
      if (req.method === "DELETE" && sub) {
        const r = await handleDeleteMaterialized(schemaName, collection, sub);
        audit(colAr, colResource, false, r.status);
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
      if (req.method === "GET" && version !== "raw") {
        const effectiveLabel = colAr.labelFilter ?? url.searchParams.get("label") ?? undefined;
        const effectiveUrl = effectiveLabel
          ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
          : url;
        let r = await handleGetByKey(schemaName, collection, keyValue, effectiveUrl);
        r = await withRefResolution(r, schemaName, url, effectiveLabel, resource => checkAccess(orgId, user.userId, principal, resource, "read"));
        audit(colAr, colResource, true, r.status);
        return filterResponse(r, colAr);
      }
      if (req.method === "GET" && version === "raw") {
        // GET /{collection}/by-key/{name}/raw — the file's bytes
        const [doc] = await withTenant(schemaName, tx => tx<{ id: string }[]>`
          SELECT id FROM documents WHERE collection = ${collection} AND natural_key = ${keyValue} AND deleted_at IS NULL
        `);
        const r = doc
          ? await handleGetAssetRaw(schemaName, collection, doc.id, url, colAr.labelFilter ?? undefined)
          : Response.json({ error: "Not found" }, { status: 404 });
        audit(colAr, colResource, true, r.status);
        return r;
      }
      if (req.method === "PUT") {
        const multipart = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
        const { res, id: docId } = multipart
          ? await handleUpsertAssetByKey(schemaName, collection, keyValue, req, user.userId)
          : await handleUpsertByKey(schemaName, collection, keyValue, req, user.userId);
        audit(colAr, colResource, false, res.status);
        if (res.status < 400 && docId) {
          purgeForDocument(orgId, collection, docId).catch(() => {});
          refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
        }
        return res;
      }
      if (req.method === "DELETE") {
        const { res, id: docId } = await handleDeleteByKey(schemaName, collection, keyValue, expectedVersion(req));
        audit(colAr, colResource, false, res.status);
        if (res.status < 400 && docId) {
          purgeForDocument(orgId, collection, docId).catch(() => {});
          refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
        }
        return res;
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Route: GET /{collection}/{id}/raw  (binary asset download)
    if (req.method === "GET" && id && sub === "raw") {
      const r = await handleGetAssetRaw(schemaName, collection, id, url, colAr.labelFilter ?? undefined);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Route: GET /{collection}/{id}
    if (req.method === "GET" && id && !sub) {
      const effectiveLabel = colAr.labelFilter ?? url.searchParams.get("label") ?? undefined;
      const effectiveUrl = effectiveLabel
        ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
        : url;
      let r = await handleGet(schemaName, collection, id, effectiveUrl);
      r = await withRefResolution(r, schemaName, url, effectiveLabel, resource => checkAccess(orgId, user.userId, principal, resource, "read"));
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
        refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
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
        refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
      }
      return r;
    }

    // Route: DELETE /{collection}/{id}
    if (req.method === "DELETE" && id && !sub) {
      const r = await handleDelete(schemaName, collection, id, expectedVersion(req));
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
        refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
      }
      return r;
    }

    // Route: GET /{collection}/{id}/paths
    if (req.method === "GET" && id && sub === "paths" && !version) {
      const r = await handleDocumentPaths(schemaName, collection, id);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // History would show versions a label-filtered rule hides, and a diff shows data a
    // data filter would remove: neither is available under such a rule.
    const historyDenied = (showsData: boolean) => colAr.labelFilter
      ? Response.json({ error: `This rule only shows the "${colAr.labelFilter}" version` }, { status: 403 })
      : showsData && colAr.filterExpr
        ? Response.json({ error: "Diffs aren't available under a rule with a data filter" }, { status: 403 })
        : null;

    // Route: GET /{collection}/{id}/versions
    if (req.method === "GET" && id && sub === "versions" && !version) {
      const denied = historyDenied(false);
      if (denied) return denied;
      const r = await handleVersionList(schemaName, collection, id);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    // Route: GET /{collection}/{id}/versions/{v}
    if (req.method === "GET" && id && sub === "versions" && version) {
      const denied = historyDenied(false);
      if (denied) return denied;
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
        refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
      }
      return r;
    }

    // Route: DELETE /{collection}/{id}/labels/{label}
    if (req.method === "DELETE" && id && sub === "labels" && version) {
      const r = await handleRemoveLabel(schemaName, collection, id, decodeURIComponent(version));
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) purgeForDocument(orgId, collection, id).catch(() => {});
      return r;
    }

    // Route: POST /{collection}/{id}/undelete
    if (req.method === "POST" && id && sub === "undelete" && !version) {
      const r = await handleUndelete(schemaName, collection, id);
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
        purgeForCollection(orgId, collection).catch(() => {});
        refreshMaterializedForCollection(schemaName, collection, user.userId).catch(() => {});
      }
      return r;
    }

    // Route: POST /{collection}/{id}/labels
    if (req.method === "POST" && id && sub === "labels") {
      const r = await handleLabel(schemaName, collection, id, req, user.userId);
      audit(colAr, colResource, false, r.status);
      if (r.status < 400) {
        purgeForDocument(orgId, collection, id).catch(() => {});
      }
      return r;
    }

    // Route: GET /{collection}/{id}/diff
    if (req.method === "GET" && id && sub === "diff") {
      const denied = historyDenied(true);
      if (denied) return denied;
      const r = await handleDiff(schemaName, collection, id, url);
      audit(colAr, colResource, true, r.status);
      return r;
    }

    return Response.json({ error: "Not found" }, { status: 404 });
}

// -------------------------------------------------------
// Handlers
// -------------------------------------------------------

// ── Query helpers ────────────────────────────────────────────────────────────

const SAFE_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;
const SAFE_ARRAY_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\[\])?(\.([a-zA-Z_][a-zA-Z0-9_]*)(\[\])?)*$/;
const MAX_SELECT_FIELDS = 20;
const MAX_METRICS = 10;
const MAX_UNNEST_DEPTH = 4;
const QUERY_TIMEOUT_MS = 5000;

/** Parse and validate ?select= paths (top-level or dot-path, no arrays). */
function parseSelectPaths(raw: string | null): string[] | null {
  if (!raw) return null;
  const paths = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (paths.length === 0) return null;
  if (paths.length > MAX_SELECT_FIELDS) throw new Error(`Maximum ${MAX_SELECT_FIELDS} select fields`);
  for (const p of paths) {
    if (!SAFE_PATH.test(p)) throw new Error(`Invalid select path: ${p}`);
  }
  return paths;
}

/** Parse paths that may include [] for array unnest (used by _query). */
function parseArrayPaths(paths: string[]): string[] {
  for (const p of paths) {
    if (!SAFE_ARRAY_PATH.test(p)) throw new Error(`Invalid path: ${p}`);
    const depth = (p.match(/\[\]/g) || []).length;
    if (depth > MAX_UNNEST_DEPTH) throw new Error(`Path nesting too deep (max ${MAX_UNNEST_DEPTH}): ${p}`);
  }
  return paths;
}

/**
 * Build a SQL expression for JSONB field projection.
 * Input: validated paths like ["name", "report.city", "startDate"]
 * Output: SQL string like `jsonb_build_object('name', v.data->'name', 'report.city', v.data #> '{report,city}', ...)`
 *
 * Safety: paths are validated against SAFE_PATH before this function is called.
 */
function buildProjectionSql(paths: string[]): string {
  const pairs = paths.map(p => {
    const segments = p.split(".");
    const key = `'${p}'`; // safe: validated against /^[a-zA-Z0-9_.]+$/
    const val = segments.length === 1
      ? `v.data->'${segments[0]}'`
      : `v.data #> '{${segments.join(",")}}'`;
    return `${key}, ${val}`;
  });
  return `jsonb_build_object(${pairs.join(", ")})`;
}

/**
 * Compile an array path with [] segments into LATERAL join clauses and a leaf expression.
 * Input: "report.divisions[].categories[].ranked[].gmsId"
 * Output: { laterals: [...SQL CROSS JOIN LATERAL clauses], leaf: "_u2.val->>'gmsId'" }
 */
function compileArrayPath(path: string): { laterals: string[]; leaf: string; leafJsonb: string } {
  const segments = path.split(".");
  const laterals: string[] = [];
  let currentExpr = "v.data";
  let aliasCounter = 0;
  let leafField: string | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.endsWith("[]")) {
      const key = seg.slice(0, -2);
      const alias = `_u${aliasCounter++}`;
      const source = currentExpr === "v.data"
        ? `v.data->'${key}'`
        : `${currentExpr}->'${key}'`;
      laterals.push(`CROSS JOIN LATERAL jsonb_array_elements(${source}) AS ${alias}(val)`);
      currentExpr = `${alias}.val`;
    } else if (i === segments.length - 1) {
      // Leaf field after the last array
      leafField = seg;
    } else {
      // Intermediate object traversal (no [])
      currentExpr = currentExpr === "v.data"
        ? `v.data->'${seg}'`
        : `${currentExpr}->'${seg}'`;
    }
  }

  const leaf = leafField ? `${currentExpr}->>'${leafField}'` : `${currentExpr}`;
  const leafJsonb = leafField ? `${currentExpr}->'${leafField}'` : currentExpr;
  return { laterals, leaf, leafJsonb };
}

// Whitelist of operators for the where clause compiler
const WHERE_OPS: Record<string, string> = {
  ":": "=", "=": "=", "!=": "!=",
  ">": ">", ">=": ">=", "<": "<", "<=": "<=",
  "~*": "~*", "!~*": "!~*", "@>": "@>",
};

/**
 * Compile a simple filter expression to a parameterized SQL WHERE clause.
 * Grammar: path operator value, optionally joined by AND / OR.
 * Returns { sql: string, params: unknown[] }.
 */
function compileWhere(where: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  // Split on AND/OR while preserving the operator
  const parts = where.split(/\s+(AND|OR)\s+/i);
  const sqlParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (part.toUpperCase() === "AND") { sqlParts.push("AND"); continue; }
    if (part.toUpperCase() === "OR") { sqlParts.push("OR"); continue; }

    // Parse: path operator value. Split at the first operator in the text, and at
    // that position take the longest one (so "!~*" isn't read as "!" + "~*", and a
    // ":" or "=" inside the value doesn't end the path).
    let matched = false;
    let best: { op: string; idx: number } | null = null;
    for (const op of ["!~*", "!=", ">=", "<=", "~*", "@>", ":", "=", ">", "<"]) {
      const idx = part.indexOf(op);
      if (idx > 0 && (!best || idx < best.idx || (idx === best.idx && op.length > best.op.length))) best = { op, idx };
    }
    if (best) {
      const { op, idx } = best;
      const path = part.slice(0, idx).trim();
      const value = part.slice(idx + op.length).trim();
      // Accept both simple paths and array-unnest paths
      if (!SAFE_PATH.test(path) && !SAFE_ARRAY_PATH.test(path)) throw new Error(`Invalid filter path: ${path}`);
      const sqlOp = WHERE_OPS[op];

      // Array paths with [] → EXISTS subquery with LATERAL unnest
      if (path.includes("[]")) {
        const compiled = compileArrayPath(path);
        const cleanValue = value.replace(/^['"]|['"]$/g, "");
        params.push(cleanValue);
        const existsSql = `EXISTS (SELECT 1 FROM documents _fd
          JOIN versions _fv ON _fv.document_id = _fd.id AND _fv.version = _fd.current_version
          ${compiled.laterals.join("\n            ")}
          WHERE _fd.id = d.id AND ${compiled.leaf} ${sqlOp} $${params.length})`;
        sqlParts.push(existsSql);
      } else {
        const segments = path.split(".");
        const jsonPath = segments.length === 1
          ? `v.data->>'${segments[0]}'`
          : `v.data #>> '{${segments.join(",")}}'`;

        if (op === "@>") {
          const jsonSegments = segments.length === 1 ? `v.data->'${segments[0]}'` : `v.data #> '{${segments.join(",")}}'`;
          try { JSON.parse(value); } catch { throw new Error(`@> needs a JSON value: ${value}`); }
          params.push(value);
          // bind as text, then parse once (binding as jsonb would encode the string again)
          sqlParts.push(`${jsonSegments} @> ($${params.length}::text)::jsonb`);
        } else if ([">", ">=", "<", "<="].includes(op)) {
          // A number compares numerically; anything else compares as text, so ISO
          // dates and times ("2026-10-05", "2026-10-05T09:30:00Z") range correctly.
          const bare = value.replace(/^['"]|['"]$/g, "");
          if (/^-?\d+(\.\d+)?$/.test(bare)) {
            params.push(parseFloat(bare));
            sqlParts.push(`(${jsonPath})::numeric ${sqlOp} $${params.length}`);
          } else {
            params.push(bare);
            sqlParts.push(`${jsonPath} ${sqlOp} $${params.length}`);
          }
        } else {
          const cleanValue = value.replace(/^['"]|['"]$/g, "");
          params.push(cleanValue);
          sqlParts.push(`${jsonPath} ${sqlOp} $${params.length}`);
        }
      }
      matched = true;
    }
    if (!matched) throw new Error(`Invalid filter expression: ${part}`);
  }

  return { sql: sqlParts.join(" "), params };
}

async function handleList(
  schemaName: string,
  collection: string,
  url: URL,
  _userId: string,
  labelFilter?: string,
): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  // The permission label filter wins over ?label= (same as get/tree/_query), otherwise
  // a public reader could pass ?label=draft or ?label= to see unpublished versions.
  const effectiveLabel = labelFilter ?? url.searchParams.get("label") ?? undefined;

  // ?select= field projection
  let selectPaths: string[] | null = null;
  try {
    selectPaths = parseSelectPaths(url.searchParams.get("select"));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  // ?where= SQL-level filter
  let whereClause: { sql: string; params: unknown[] } | null = null;
  const whereParam = url.searchParams.get("where");
  if (whereParam) {
    try {
      whereClause = compileWhere(whereParam);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const dataExpr = selectPaths ? buildProjectionSql(selectPaths) : "v.data";


  const [items, [{ total }]] = await withTenant(schemaName, async tx => {
    let rows: { id: string; version: number; data: unknown; created_at: Date; updated_at: Date; labels: string[] }[];
    if (effectiveLabel) {
      // Params: $1=label, $2=collection, $3=limit, $4=offset, then where params
      const baseCount = 4;
      const whereExtra = whereClause ? ` AND (${renum(whereClause.sql, baseCount)})` : "";
      rows = await tx.unsafe<typeof rows>(
        `SELECT d.id, lf.version, ${dataExpr} AS data, d.created_at, d.updated_at,
                COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
         FROM documents d
         JOIN labels lf ON lf.document_id = d.id AND lf.label = $1
         JOIN versions v ON v.document_id = d.id AND v.version = lf.version
         LEFT JOIN labels l ON l.document_id = d.id
         WHERE d.collection = $2 AND d.deleted_at IS NULL${whereExtra}
         GROUP BY d.id, lf.version, v.data, d.created_at, d.updated_at
         ORDER BY d.created_at DESC
         LIMIT $3 OFFSET $4`,
        [effectiveLabel, collection, limit, offset, ...(whereClause?.params ?? [])],
      );
    } else {
      // Params: $1=collection, $2=limit, $3=offset, then where params
      const baseCount = 3;
      const whereExtra = whereClause ? ` AND (${renum(whereClause.sql, baseCount)})` : "";
      rows = await tx.unsafe<typeof rows>(
        `SELECT d.id, d.current_version AS version, ${dataExpr} AS data, d.created_at, d.updated_at,
                COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
         FROM documents d
         JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
         LEFT JOIN labels l ON l.document_id = d.id
         WHERE d.collection = $1 AND d.deleted_at IS NULL${whereExtra}
         GROUP BY d.id, d.current_version, v.data, d.created_at, d.updated_at
         ORDER BY d.created_at DESC
         LIMIT $2 OFFSET $3`,
        [collection, limit, offset, ...(whereClause?.params ?? [])],
      );
    }
    // Count query — same where clause, different base param count
    const countBaseParams = effectiveLabel ? 2 : 1;
    const countWhere = whereClause ? ` AND (${renum(whereClause.sql, countBaseParams)})` : "";
    const countParams = effectiveLabel ? [effectiveLabel, collection] : [collection];
    const count = effectiveLabel
      ? await tx.unsafe<{ total: string }[]>(
          `SELECT COUNT(*)::text AS total FROM documents d
           JOIN labels lf ON lf.document_id = d.id AND lf.label = $1
           JOIN versions v ON v.document_id = d.id AND v.version = lf.version
           WHERE d.collection = $2 AND d.deleted_at IS NULL${countWhere}`,
          [...countParams, ...(whereClause?.params ?? [])],
        )
      : await tx.unsafe<{ total: string }[]>(
          `SELECT COUNT(*)::text AS total FROM documents d
           JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
           WHERE d.collection = $1 AND d.deleted_at IS NULL${countWhere}`,
          [...countParams, ...(whereClause?.params ?? [])],
        );
    return [rows, count];
  });

  return Response.json({
    collection,
    items: items.map(r => ({ id: r.id, version: r.version, data: r.data, createdAt: r.created_at, updatedAt: r.updated_at, labels: r.labels })),
    total: parseInt(total),
  });
}

// ── Query API: POST /{collection}/_query ─────────────────────────────────────

interface QueryRequest {
  where?: string;
  select?: string[];
  aggregate?: {
    groupBy?: string[];
    metrics?: Record<string, Record<string, string>>;
  };
  label?: string;
  limit?: number;
  cursor?: string;
}

async function handleQuery(
  schemaName: string,
  collection: string,
  req: Request,
  ar: AccessResult,
): Promise<Response> {
  let body: QueryRequest;

  if (req.method === "GET") {
    // GET: parse from URL params — supports ?q=<base64url JSON> or individual params
    const url = new URL(req.url);
    const qParam = url.searchParams.get("q");
    if (qParam) {
      try {
        body = JSON.parse(Buffer.from(qParam, "base64url").toString()) as QueryRequest;
      } catch {
        return Response.json({ error: "Invalid ?q= parameter (expected base64url-encoded JSON)" }, { status: 400 });
      }
    } else {
      // Individual params: ?select=a,b&where=x:y&label=published&limit=10
      body = {};
      const sel = url.searchParams.get("select");
      if (sel) body.select = sel.split(",").map(s => s.trim());
      const where = url.searchParams.get("where");
      if (where) body.where = where;
      const label = url.searchParams.get("label");
      if (label) body.label = label;
      const limit = url.searchParams.get("limit");
      if (limit) body.limit = parseInt(limit);
      const cursor = url.searchParams.get("cursor");
      if (cursor) body.cursor = cursor;
      // Aggregate via ?q= only — too complex for individual params
    }
  } else {
    // POST: parse from JSON body
    try {
      body = await req.json() as QueryRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  // Validate select paths
  let selectPaths: string[] | null = null;
  if (body.select) {
    try {
      if (body.select.length > MAX_SELECT_FIELDS) throw new Error(`Maximum ${MAX_SELECT_FIELDS} select fields`);
      for (const p of body.select) {
        if (!SAFE_PATH.test(p) && !SAFE_ARRAY_PATH.test(p)) throw new Error(`Invalid select path: ${p}`);
      }
      selectPaths = body.select;
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  // Validate aggregate
  if (body.aggregate?.metrics) {
    const metricCount = Object.keys(body.aggregate.metrics).length;
    if (metricCount > MAX_METRICS) {
      return Response.json({ error: `Maximum ${MAX_METRICS} metrics` }, { status: 400 });
    }
    try {
      for (const [, def] of Object.entries(body.aggregate.metrics)) {
        const path = def.count ?? def.countDistinct ?? def.sum ?? def.min ?? def.max ?? def.avg;
        if (path) parseArrayPaths([path]);
        if (def.by) parseArrayPaths([def.by]);
      }
      if (body.aggregate.groupBy) {
        for (const g of body.aggregate.groupBy) {
          if (g.startsWith("$")) continue; // pseudo-paths like $documentId
          if (!SAFE_PATH.test(g) && !SAFE_ARRAY_PATH.test(g)) throw new Error(`Invalid groupBy path: ${g}`);
        }
      }
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const effectiveLabel = ar.labelFilter ?? body.label;
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 1000);

  // Compile the where clause
  let whereClause: { sql: string; params: unknown[] } | null = null;
  if (body.where) {
    try { whereClause = compileWhere(body.where); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  }

  // Cursor decoding — uses document id only (unique, avoids timestamp precision issues)
  let cursorParams: unknown[] = [];
  if (body.cursor) {
    try {
      const c = JSON.parse(Buffer.from(body.cursor, "base64url").toString());
      cursorParams = [c.id];
    } catch {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }

  try {
    const result = await withTenant(schemaName, async tx => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}'`);

      // ── Non-aggregate mode: return projected documents ──
      if (!body.aggregate) {
        const dataExpr = selectPaths ? buildProjectionSql(selectPaths) : "v.data";

        // Build param list
        const params: unknown[] = [];
        let labelJoin = "";
        let versionJoin: string;
        if (effectiveLabel) {
          params.push(effectiveLabel); // $1
          labelJoin = `JOIN labels lf ON lf.document_id = d.id AND lf.label = $1`;
          versionJoin = `JOIN versions v ON v.document_id = d.id AND v.version = lf.version`;
        } else {
          versionJoin = `JOIN versions v ON v.document_id = d.id AND v.version = d.current_version`;
        }
        params.push(collection); // $2 or $1
        const collParam = `$${params.length}`;

        // Where clause
        const baseCount = params.length;
        let extraWhere = "";
        if (whereClause) {
          extraWhere = ` AND (${renum(whereClause.sql, baseCount)})`;
          params.push(...whereClause.params);
        }

        // Cursor: continue after the cursor's document in (created_at, id) order. Its
        // timestamp is read from the database, so microsecond precision is kept.
        if (cursorParams.length) {
          params.push(...cursorParams);
          const idParam = `$${params.length}`;
          extraWhere += ` AND (d.created_at, d.id) < (SELECT c.created_at, c.id FROM documents c WHERE c.id = ${idParam})`;
        }

        params.push(limit + 1); // over-fetch by 1 for cursor
        const limitParam = `$${params.length}`;

        const sql = `
          SELECT d.id, ${effectiveLabel ? "lf.version" : "d.current_version AS version"},
                 ${dataExpr} AS data, d.created_at, d.updated_at
          FROM documents d
          ${labelJoin}
          ${versionJoin}
          WHERE d.collection = ${collParam} AND d.deleted_at IS NULL${extraWhere}
          ORDER BY d.created_at DESC, d.id DESC
          LIMIT ${limitParam}`;

        const rows = await tx.unsafe<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>(sql, params);

        const hasMore = rows.length > limit;
        const items = (hasMore ? rows.slice(0, limit) : rows).map(r => ({
          id: r.id, version: r.version, data: r.data,
          createdAt: r.created_at, updatedAt: r.updated_at,
        }));

        const nextCursor = hasMore
          ? Buffer.from(JSON.stringify({ id: items[items.length - 1].id })).toString("base64url")
          : null;

        return { items, cursor: nextCursor };
      }

      // ── Aggregate mode ──
      const agg = body.aggregate;
      const metrics = agg.metrics ?? {};
      const groupBy = agg.groupBy ?? ["$documentId"];

      // Build the base CTE: join documents + versions, apply label + where
      const params: unknown[] = [];
      let labelJoin = "";
      let versionJoin: string;
      if (effectiveLabel) {
        params.push(effectiveLabel);
        labelJoin = `JOIN labels lf ON lf.document_id = d.id AND lf.label = $1`;
        versionJoin = `JOIN versions v ON v.document_id = d.id AND v.version = lf.version`;
      } else {
        versionJoin = `JOIN versions v ON v.document_id = d.id AND v.version = d.current_version`;
      }
      params.push(collection);
      const collParam = `$${params.length}`;

      const baseCount = params.length;
      let extraWhere = "";
      if (whereClause) {
        extraWhere = ` AND (${renum(whereClause.sql, baseCount)})`;
        params.push(...whereClause.params);
      }

      // Collect all array paths that need LATERAL unnesting
      const allLaterals: string[] = [];
      const metricExprs: string[] = [];
      const metricNames: string[] = [];
      const numericMetrics = new Set<string>(); // count, countDistinct, sum, avg
      let lateralIdx = 0;

      for (const [name, def] of Object.entries(metrics)) {
        const op = Object.keys(def).find(k => k !== "by") as string;
        const path = def[op];
        if (!path) continue;

        const compiled = compileArrayPath(path);
        // Merge laterals (deduplicate by checking if already added)
        for (const lat of compiled.laterals) {
          if (!allLaterals.includes(lat)) allLaterals.push(lat);
        }

        const leaf = compiled.leaf;
        switch (op) {
          case "count":        metricExprs.push(`COUNT(${leaf}) AS "${name}"`); break;
          case "countDistinct": metricExprs.push(`COUNT(DISTINCT ${leaf}) AS "${name}"`); break;
          case "sum":          metricExprs.push(`SUM((${leaf})::numeric) AS "${name}"`); break;
          case "min":          metricExprs.push(`MIN(${leaf}) AS "${name}"`); break;
          case "max":          metricExprs.push(`MAX(${leaf}) AS "${name}"`); break;
          case "avg":          metricExprs.push(`AVG((${leaf})::numeric) AS "${name}"`); break;
        }
        metricNames.push(name);
        if (op !== "min" && op !== "max") numericMetrics.add(name);
      }

      // Build groupBy expressions — array paths with [] get LATERAL joins
      const groupExprs: string[] = [];
      const selectGroupExprs: string[] = [];
      for (const g of groupBy) {
        if (g === "$documentId") {
          groupExprs.push("d.id");
          selectGroupExprs.push("d.id AS doc_id");
        } else if (g === "$path") {
          groupExprs.push("p.path");
          selectGroupExprs.push("p.path AS doc_path");
        } else if (g === "$collection") {
          groupExprs.push("d.collection");
          selectGroupExprs.push("d.collection");
        } else if (g.includes("[]")) {
          // Array path — compile LATERAL joins and use the leaf as the group key
          const compiled = compileArrayPath(g);
          for (const lat of compiled.laterals) {
            if (!allLaterals.includes(lat)) allLaterals.push(lat);
          }
          groupExprs.push(compiled.leaf);
          selectGroupExprs.push(`${compiled.leaf} AS "${g}"`);
        } else {
          // Simple JSON field path (no arrays)
          const segments = g.split(".");
          const expr = segments.length === 1
            ? `v.data->>'${segments[0]}'`
            : `v.data #>> '{${segments.join(",")}}'`;
          groupExprs.push(expr);
          selectGroupExprs.push(`${expr} AS "${g}"`);
        }
      }

      const needsPathJoin = groupBy.includes("$path");
      const pathJoin = needsPathJoin ? "LEFT JOIN paths p ON p.document_id = d.id" : "";

      // Also add select projection fields if present
      if (selectPaths) {
        for (const sp of selectPaths) {
          const segments = sp.split(".");
          const expr = segments.length === 1
            ? `v.data->>'${segments[0]}'`
            : `v.data #>> '{${segments.join(",")}}'`;
          if (!groupExprs.includes(expr)) {
            groupExprs.push(expr);
            selectGroupExprs.push(`${expr} AS "${sp}"`);
          }
        }
      }

      params.push(limit);
      const limitParam = `$${params.length}`;

      const sql = `
        SELECT ${[...selectGroupExprs, ...metricExprs].join(", ")}
        FROM documents d
        ${labelJoin}
        ${versionJoin}
        ${pathJoin}
        ${allLaterals.join("\n        ")}
        WHERE d.collection = ${collParam} AND d.deleted_at IS NULL${extraWhere}
        GROUP BY ${groupExprs.join(", ")}
        ORDER BY ${groupExprs[0]} ASC
        LIMIT ${limitParam}`;

      const rows = await tx.unsafe<Record<string, unknown>[]>(sql, params);

      return {
        rows: rows.map(r => {
          const key: Record<string, unknown> = {};
          for (const g of groupBy) {
            if (g === "$documentId") key.$documentId = r.doc_id;
            else if (g === "$path") key.$path = r.doc_path;
            else if (g === "$collection") key.$collection = r.collection;
            else key[g] = r[g];
          }
          // Include select fields in the row
          if (selectPaths) {
            for (const sp of selectPaths) {
              key[sp] = r[sp];
            }
          }
          const metricValues: Record<string, unknown> = {};
          for (const name of metricNames) {
            const val = r[name];
            // count/sum/avg are numbers (Postgres returns bigint/numeric as strings, e.g.
            // "2024.5000000000000000"). min/max keep their type unless the value is a plain number.
            if (typeof val === "string") {
              const num = Number(val);
              metricValues[name] = numericMetrics.has(name) || (!isNaN(num) && String(num) === val.trim()) ? num : val;
            } else {
              metricValues[name] = val;
            }
          }
          return { key, ...metricValues };
        }),
      };
    });

    // Apply permission filterExpr post-query if needed
    if (ar.filterExpr && ar.filterLang && result.items) {
      result.items = await Promise.all(
        result.items.map(async (item: { data: unknown }) => ({
          ...item,
          data: await applyDataFilter(item.data, ar.filterLang!, ar.filterExpr!),
        }))
      );
    }

    return Response.json(result);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("statement timeout")) {
      return Response.json({ error: "Query timed out (max 5s). Try narrowing the filter or adding indexes." }, { status: 408 });
    }
    console.error("[query]", msg);
    return Response.json({ error: "Query failed: " + msg }, { status: 500 });
  }
}

// Helper: offset $N placeholders (used by handleQuery and handleList)
function renum(sql: string, offset: number): string {
  return sql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + offset}`);
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

type AssetMeta = { _binary: true; filename: string; mimeType: string; size: number; sha256: string };

/** An uploaded file's bytes and the metadata stored as its version's data. */
async function readUpload(file: File): Promise<{ buffer: Buffer; meta: AssetMeta }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    buffer,
    meta: {
      _binary:  true,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size:     buffer.byteLength,
      // Identifies the bytes: deploy tools compare it to skip unchanged files, and
      // storage is keyed by it, so identical files are stored once (asset_blobs).
      sha256:   new Bun.CryptoHasher("sha256").update(buffer).digest("hex"),
    },
  };
}

async function insertAssetVersion(tx: Sql, docId: string, version: number, buffer: Buffer, meta: AssetMeta, userId: string): Promise<void> {
  await tx`
    INSERT INTO asset_blobs (sha256, data, size) VALUES (${meta.sha256}, ${buffer}, ${meta.size})
    -- Reusing an existing blob locks its row until this upload commits, so a retention
    -- run can't remove it in between (its delete waits, then sees the new reference)
    ON CONFLICT (sha256) DO UPDATE SET size = EXCLUDED.size
  `;
  await tx`
    INSERT INTO versions (document_id, version, data, created_by)
    VALUES (${docId}, ${version}, ${tx.json(meta)}, ${userId})
  `;
  await tx`
    INSERT INTO asset_contents (document_id, version, sha256, mime_type, filename, size)
    VALUES (${docId}, ${version}, ${meta.sha256}, ${meta.mimeType}, ${meta.filename}, ${meta.size})
  `;
}

type AssetWrite = { id: string; version: number; created: boolean; unchanged: boolean; created_at: Date; updated_at: Date };

/**
 * Write a file into a document inside a transaction: a new document when docId is null,
 * otherwise a new version of it (locked, so two uploads can't take the same number).
 * The same bytes, name and type as the current version create no version. For a
 * collection with a natural key (e.g. "filename"), the document's key follows the file.
 */
async function writeAsset(tx: Sql, collection: string, docId: string | null, buffer: Buffer, meta: AssetMeta, keyed: boolean, naturalKey: string | null, userId: string, expect: Expect = null): Promise<AssetWrite | { mismatch: number } | null> {
  if (!docId) {
    if (conditionFails(expect, 0)) return { mismatch: 0 };
    const [row] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      INSERT INTO documents (collection, current_version, natural_key, created_by)
      VALUES (${collection}, 1, ${naturalKey}, ${userId})
      RETURNING id, created_at, updated_at
    `;
    await insertAssetVersion(tx, row.id, 1, buffer, meta, userId);
    return { id: row.id, version: 1, created: true, unchanged: false, created_at: row.created_at, updated_at: row.updated_at };
  }
  const [cur] = await tx<{ current_version: number; created_at: Date; updated_at: Date; sha256: string | null; filename: string | null; mime_type: string | null }[]>`
    SELECT d.current_version, d.created_at, d.updated_at, ac.sha256, ac.filename, ac.mime_type
    FROM documents d
    LEFT JOIN asset_contents ac ON ac.document_id = d.id AND ac.version = d.current_version
    WHERE d.id = ${docId} AND d.collection = ${collection} AND d.deleted_at IS NULL
    FOR UPDATE OF d
  `;
  if (!cur) return expect === null || expect === "exists" ? null : { mismatch: 0 };
  if (conditionFails(expect, cur.current_version)) return { mismatch: cur.current_version };
  // Re-running a sync or deploy with an unchanged file doesn't grow history
  if (cur.sha256 === meta.sha256 && cur.filename === meta.filename && cur.mime_type === meta.mimeType) {
    return { id: docId, version: cur.current_version, created: false, unchanged: true, created_at: cur.created_at, updated_at: cur.updated_at };
  }
  const version = cur.current_version + 1;
  await insertAssetVersion(tx, docId, version, buffer, meta, userId);
  const [row] = await tx<{ created_at: Date; updated_at: Date }[]>`
    UPDATE documents SET current_version = ${version}, updated_at = NOW(),
      natural_key = CASE WHEN ${keyed} THEN ${naturalKey} ELSE natural_key END
    WHERE id = ${docId}
    RETURNING created_at, updated_at
  `;
  return { id: docId, version, created: false, unchanged: false, created_at: row.created_at, updated_at: row.updated_at };
}

const assetJson = (collection: string, w: AssetWrite, meta: AssetMeta, naturalKey: string | null) => ({
  id: w.id, version: w.version, collection,
  data: meta,
  ...(naturalKey ? { naturalKey } : {}),
  ...(w.unchanged ? { unchanged: true } : {}),
  createdAt: w.created_at, updatedAt: w.updated_at,
});

async function uploadedFile(req: Request): Promise<File | Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const body = Buffer.from(await req.arrayBuffer());
  const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file field" }, { status: 400 });
  // Bun's parser drops the part's own Content-Type and guesses from the file name
  // instead ("notes" sent as text/plain comes back untyped), so read it ourselves.
  // A generic octet-stream says nothing, so the guess from the name still wins then.
  const declared = declaredPartType(body, contentType, "file");
  return declared && declared !== "application/octet-stream" && declared !== file.type
    ? new File([file], file.name, { type: declared })
    : file;
}

/** The Content-Type header of the multipart part named `field`, or null. */
function declaredPartType(body: Buffer, contentType: string, field: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const delim = Buffer.from(`--${m[1] ?? m[2]}`);
  for (let i = body.indexOf(delim); i !== -1; ) {
    const headEnd = body.indexOf("\r\n\r\n", i);
    if (headEnd === -1) return null;
    const head = body.subarray(i + delim.length, headEnd).toString("latin1");
    if (new RegExp(`^content-disposition:[^\\r\\n]*[;\\s]name="${field}"`, "im").test(head)) {
      return /^content-type:[ \t]*([^\r\n]+)/im.exec(head)?.[1].trim().toLowerCase() || null;
    }
    i = body.indexOf(delim, headEnd);
  }
  return null;
}

const fileKeyConflict = (collection: string, key: string | null) => Response.json({
  error: "Natural key conflict",
  details: `Another file in '${collection}' is already named '${key}'. Replace it with PUT /api/v1/${collection}/by-key/${encodeURIComponent(key ?? "")}.`,
}, { status: 409 });

async function handleCreateAsset(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const file = await uploadedFile(req);
  if (file instanceof Response) return file;
  const { buffer, meta } = await readUpload(file);
  const naturalKey = await extractNaturalKey(schemaName, collection, meta);
  try {
    const w = await withTenant(schemaName, tx => writeAsset(tx, collection, null, buffer, meta, true, naturalKey, userId));
    return Response.json(assetJson(collection, w as AssetWrite, meta, naturalKey), { status: 201 });
  } catch (err) {
    if (isNaturalKeyConflict(err)) return fileKeyConflict(collection, naturalKey);
    throw err;
  }
}

async function handleUpdateAsset(schemaName: string, collection: string, docId: string, req: Request, userId: string): Promise<Response> {
  const file = await uploadedFile(req);
  if (file instanceof Response) return file;
  const { buffer, meta } = await readUpload(file);
  const keyed = (await getNaturalKeyField(schemaName, collection)) !== null;
  const naturalKey = await extractNaturalKey(schemaName, collection, meta);
  try {
    const w = await withTenant(schemaName, tx => writeAsset(tx, collection, docId, buffer, meta, keyed, naturalKey, userId, expectedVersion(req)));
    if (!w) return Response.json({ error: "Not found" }, { status: 404 });
    if ("mismatch" in w) return versionMismatch(w.mismatch);
    return Response.json(assetJson(collection, w, meta, naturalKey));
  } catch (err) {
    if (isNaturalKeyConflict(err)) return fileKeyConflict(collection, naturalKey);
    throw err;
  }
}

/**
 * PUT /{collection}/by-key/{name} with a multipart file: create the file, or replace it
 * if it changed. For file collections whose schema has naturalKey "filename"; the
 * stored file is named by its key. Returns 201 when created.
 */
async function handleUpsertAssetByKey(schemaName: string, collection: string, keyValue: string, req: Request, userId: string): Promise<{ res: Response; id: string | null }> {
  const field = await getNaturalKeyField(schemaName, collection);
  if (field !== "filename") {
    return { res: Response.json({
      error: "No file key configured",
      details: `Upload files by key with naturalKey "filename": PUT /api/v1/${collection}/_schema {"collectionType":"binary","naturalKey":"filename"}.`,
    }, { status: 400 }), id: null };
  }
  const file = await uploadedFile(req);
  if (file instanceof Response) return { res: file, id: null };
  const { buffer, meta } = await readUpload(file);
  // The stored file is named by its key, and its type follows that name (not whatever
  // name the upload happened to carry), so re-sending an unchanged file is a no-op
  meta.filename = keyValue;
  const byName = Bun.file(keyValue).type;
  if (byName && byName !== "application/octet-stream") meta.mimeType = byName;
  try {
    const w = await withTenant(schemaName, async tx => {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM documents WHERE collection = ${collection} AND natural_key = ${keyValue} AND deleted_at IS NULL
        FOR UPDATE
      `;
      return writeAsset(tx, collection, existing?.id ?? null, buffer, meta, true, keyValue, userId, expectedVersion(req));
    });
    if (w && "mismatch" in w) return { res: versionMismatch(w.mismatch), id: null };
    const ok = w as AssetWrite;
    return { res: Response.json(assetJson(collection, ok, meta, keyValue), { status: ok.created ? 201 : 200 }), id: ok.id };
  } catch (err) {
    if (isNaturalKeyConflict(err)) return { res: fileKeyConflict(collection, keyValue), id: null };
    throw err;
  }
}

async function handleGetAssetRaw(schemaName: string, collection: string, docId: string, url: URL, labelFilter?: string): Promise<Response> {
  // A permission label filter pins the version and overrides ?version=/?label=.
  const label = labelFilter ?? url.searchParams.get("label") ?? undefined;
  const versionParam = label ? null : url.searchParams.get("version");
  const rows = await withTenant(schemaName, async tx => {
    // Every branch checks the collection, so a rule on one collection can't be
    // used to read raw bytes of a document in another.
    if (label) {
      return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
        SELECT b.data, ac.mime_type, ac.filename
        FROM asset_contents ac
        JOIN asset_blobs b ON b.sha256 = ac.sha256
        JOIN labels l ON l.document_id = ac.document_id AND l.version = ac.version AND l.label = ${label}
        JOIN documents d ON d.id = ac.document_id
        WHERE ac.document_id = ${docId} AND d.collection = ${collection} AND d.deleted_at IS NULL
      `;
    }
    if (versionParam) {
      return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
        SELECT b.data, ac.mime_type, ac.filename
        FROM asset_contents ac
        JOIN asset_blobs b ON b.sha256 = ac.sha256
        JOIN documents d ON d.id = ac.document_id
        WHERE ac.document_id = ${docId} AND ac.version = ${parseInt(versionParam)}
          AND d.collection = ${collection} AND d.deleted_at IS NULL
      `;
    }
    return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
      SELECT b.data, ac.mime_type, ac.filename
      FROM asset_contents ac
      JOIN asset_blobs b ON b.sha256 = ac.sha256
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
    WHERE p.principal = '*' AND p.access <> 'none'  -- a 'none' rule closes a resource
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
  const base = publicBase(url);
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
      // /api/v1/orgs/{slug} on its own is not a route; the org's llms.txt describes everything it publishes
      url: `${base}/orgs/${org.slug}/llms.txt`,
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
  req?: Request,
  extra?: string, // the segment after a by-key value: "raw" downloads the file
): Promise<Response> {
  // Resolve org from slug
  const slugRows = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_slugs WHERE slug = ${slug}
  `;
  if (!slugRows.length) return Response.json({ error: "Not found" }, { status: 404 });
  const orgId = slugRows[0].org_id;

  const schemaName = sanitizeSchemaName(orgId);

  // ── Alias resolution ──
  // Check if the collection/tree name is actually an alias on a permission rule.
  // If so, resolve it to the real resource name. Aliases only work for principal='*' rules.
  let resolvedCollection = collection;
  let treeAlias: string | null = null; // the URL said /{alias}/… instead of /tree/{name}/…
  if (collection !== "tree" && collection !== "wren.js" && collection !== "llms.txt") {
    const aliasRow = await sql<{ resource: string }[]>`
      SELECT resource FROM common.permissions
      WHERE org_id = ${orgId} AND alias = ${collection} AND principal = '*'
      LIMIT 1
    `.catch(() => []);
    if (aliasRow.length > 0) {
      // Alias found — extract the real name from "collection:xxx" or "tree:xxx"
      const [kind, realName] = aliasRow[0].resource.split(":");
      if (kind === "tree") {
        // Redirect to tree handler with the real tree name
        resolvedCollection = "tree";
        id = realName;
        treeAlias = collection;
      } else {
        resolvedCollection = realName;
      }
    }
  }

  // ── Public tree access: GET /orgs/{slug}/tree/{treeName}[/{...path}] ──────
  if (resolvedCollection === "tree") {
    if (req && req.method !== "GET") return publicReadOnly();
    const treeName = id;
    if (!treeName) return Response.json({ error: "Tree name required" }, { status: 400 });

    const treeResource = `tree:${treeName}`;
    const ar = await checkAccess(orgId, "", "*", treeResource, "read");
    if (!ar.allowed) return Response.json({ error: "Forbidden" }, { status: 403 });

    // Reconstruct the full tree path from the raw URL — support both the canonical
    // /api/v1/orgs/{slug}/tree/{treeName}/... and the short /orgs/{slug}/tree/{treeName}/... alias.
    const urlTree = treeAlias ?? `tree/${treeName}`;
    const apiPrefix   = `/api/v1/orgs/${slug}/${urlTree}`;
    const shortPrefix = `/orgs/${slug}/${urlTree}`;
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
  const resource = `collection:${resolvedCollection}`;
  const ar = await checkAccess(orgId, "", "*", resource, "read");
  if (!ar.allowed) return Response.json({ error: "Forbidden" }, { status: 403 });

  // POST /orgs/{slug}/{collection}/_query — public anonymous query.
  if (id === "_query" && !sub && (req?.method === "POST" || req?.method === "GET")) {
    const r = await handleQuery(schemaName, resolvedCollection, req, ar);
    return withHeaders(r, PUBLIC_CACHE_HEADERS);
  }

  // Everything else here is read-only; a POST used to fall through and silently list.
  if (req && req.method !== "GET") return publicReadOnly();

  // GET /orgs/{slug}/{collection}/_materialized/{name} — public materialized result.
  if (id === "_materialized" && sub && req?.method === "GET") {
    const r = await handleGetMaterialized(schemaName, resolvedCollection, sub);
    return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
  }

  if (id === "_materialized" && !sub && req?.method === "GET") {
    const r = await handleListMaterialized(schemaName, resolvedCollection);
    return withHeaders(r, PUBLIC_CACHE_HEADERS);
  }

  if (id === "by-key" && sub && extra === "raw") {
    // A public file by its name (file collections with naturalKey "filename")
    const doc = await resolveNaturalKey(schemaName, resolvedCollection, decodeURIComponent(sub));
    if (!doc) return withHeaders(Response.json({ error: "Not found" }, { status: 404 }), { "Cache-Control": "no-store" });
    return withHeaders(await handleGetAssetRaw(schemaName, resolvedCollection, doc.id, url, ar.labelFilter ?? undefined), PUBLIC_CACHE_HEADERS);
  }

  if (id === "by-key" && sub) {
    const keyValue = decodeURIComponent(sub);
    const effectiveLabel = ar.labelFilter ?? url.searchParams.get("label") ?? undefined;
    const effectiveUrl = effectiveLabel
      ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
      : url;
    let r = await handleGetByKey(schemaName, resolvedCollection, keyValue, effectiveUrl);
    r = await withRefResolution(r, schemaName, url, effectiveLabel, resource => checkAccess(orgId, "", "*", resource, "read"));
    return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
  }

  if (id && sub === "raw") {
    return withHeaders(await handleGetAssetRaw(schemaName, resolvedCollection, id, url, ar.labelFilter ?? undefined), PUBLIC_CACHE_HEADERS);
  }

  if (id && !sub) {
    const effectiveLabel = ar.labelFilter ?? url.searchParams.get("label") ?? undefined;
    const effectiveUrl = effectiveLabel
      ? (() => { const u = new URL(url); u.searchParams.set("label", effectiveLabel); return u; })()
      : url;
    let r = await handleGet(schemaName, resolvedCollection, id, effectiveUrl);
    r = await withRefResolution(r, schemaName, url, effectiveLabel, resource => checkAccess(orgId, "", "*", resource, "read"));
    return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
  }

  // GET /orgs/{slug}/{collection} — list documents
  let r = await handleList(schemaName, resolvedCollection, url, "", ar.labelFilter);
  r = await withRefResolution(r, schemaName, url, ar.labelFilter, resource => checkAccess(orgId, "", "*", resource, "read"));
  return withHeaders(await filterPublicResponse(r, ar), PUBLIC_CACHE_HEADERS);
}

function publicReadOnly(): Response {
  return Response.json({
    error: "Public org URLs are read-only. Write with /api/v1/{collection} or /api/v1/tree/{tree}/{path} and an Authorization: Bearer key.",
  }, { status: 405 });
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

// ── $ref resolution ──────────────────────────────────────────────────────────
//
// Documents can contain references to other documents or tree paths:
//   { "author": { "$ref": "authors", "$id": "uuid" } }
//   { "category": { "$ref": "categories", "$key": "news" } }
//   { "nav": { "$ref": "tree:site", "$path": "/", "$limit": 10 } }
//   { "events": { "$ref": "tree:events", "$path": "/2026", "$limit": 5 } }
//
// When ?depth=N is set (default 0 = no resolution), references are resolved
// server-side by batch-fetching referenced docs and inlining their data.
// Tree refs return an array of { path, documentId, data } nodes.
// Loop detection prevents circular references from causing infinite recursion.

const MAX_REF_DEPTH = 5;
const MAX_REFS_PER_LEVEL = 50;
const DEFAULT_TREE_REF_LIMIT = 20;
const MAX_TREE_REF_LIMIT = 100;

interface RefPointer {
  path: (string | number)[];
  collection: string;
  label?: string;          // version to resolve: the caller's rule's label filter, else the request's label
  id?: string;
  key?: string;
  // Tree ref fields
  isTree?: boolean;
  treeName?: string;
  treePath?: string;
  treeLimit?: number;
  // Query ref fields
  isQuery?: boolean;
  queryCollection?: string;
  querySelect?: string[];
  queryWhere?: string;
  queryQ?: unknown; // full query body (for aggregation)
  queryLimit?: number;
  queryLabel?: string;
}

function isRef(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && "$ref" in (val as Record<string, unknown>)
    && typeof (val as Record<string, unknown>).$ref === "string";
}

/** Single-pass scan: collect all $ref objects and their JSON paths. */
function collectRefs(data: unknown, path: (string | number)[] = []): RefPointer[] {
  if (!data || typeof data !== "object") return [];
  if (isRef(data)) {
    const ref = data as Record<string, unknown>;
    const refStr = ref.$ref as string;

    // Tree reference: $ref starts with "tree:"
    if (refStr.startsWith("tree:")) {
      const treeName = refStr.slice(5);
      return [{
        path: [...path], collection: refStr, isTree: true, treeName,
        treePath: (ref.$path as string) ?? "/",
        treeLimit: Math.min(Math.max((ref.$limit as number) ?? DEFAULT_TREE_REF_LIMIT, 1), MAX_TREE_REF_LIMIT),
      }];
    }

    // Query reference: $ref starts with "query:"
    if (refStr.startsWith("query:")) {
      const queryCollection = refStr.slice(6);
      return [{
        path: [...path], collection: refStr, isQuery: true, queryCollection,
        querySelect: Array.isArray(ref.$select) ? ref.$select as string[] : undefined,
        queryWhere: typeof ref.$where === "string" ? ref.$where : undefined,
        queryQ: ref.$q,
        queryLimit: Math.min(Math.max((ref.$limit as number) ?? 20, 1), 200),
        queryLabel: typeof ref.$label === "string" ? ref.$label : undefined,
      }];
    }

    return [{ path: [...path], collection: refStr, id: ref.$id as string, key: ref.$key as string }];
  }
  const refs: RefPointer[] = [];
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      refs.push(...collectRefs(data[i], [...path, i]));
    }
  } else {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      refs.push(...collectRefs(v, [...path, k]));
    }
  }
  return refs;
}

/** Set a value at a JSON path inside a mutable object. */
function setAtPath(obj: unknown, path: (string | number)[], value: unknown): void {
  let current = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]] as Record<string | number, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/**
 * Resolve all $ref objects in a document's data, up to maxDepth levels.
 * Uses batch fetching: all refs at one depth level are resolved in a single
 * SQL query per collection. Returns a new data object with refs replaced.
 */
/** Access to "collection:<name>" or "tree:<name>" for whoever is reading (their own rules). */
type RefAccess = (resource: string) => Promise<AccessResult>;

async function resolveDocRefs(
  schemaName: string,
  data: unknown,
  maxDepth: number,
  label: string | undefined,
  access: RefAccess,
): Promise<unknown> {
  if (maxDepth <= 0) return data;

  // A ref only resolves if the reader may read its target, under their rule's label
  // filter. Rules with a data filter don't resolve refs (the filter can't be applied
  // to an inlined document safely).
  const accessCache = new Map<string, Promise<AccessResult>>();
  const canRead = (resource: string) => {
    if (!accessCache.has(resource)) accessCache.set(resource, access(resource).catch(() => ({ allowed: false, auditReads: false, auditWrites: false })));
    return accessCache.get(resource)!;
  };

  // Deep clone so we can mutate
  let current = JSON.parse(JSON.stringify(data));
  // Loop detection: a ref is circular when the same target is already among its own
  // ancestors. The same document referenced twice side by side is fine.
  // Key: JSON of a resolved ref's path → targets on the way down to it, itself included.
  const ancestry = new Map<string, Set<string>>();
  const ancestorsOf = (path: (string | number)[]) => {
    for (let n = path.length; n >= 0; n--) {
      const a = ancestry.get(JSON.stringify(path.slice(0, n)));
      if (a) return a;
    }
    return new Set<string>();
  };

  for (let depth = 0; depth < maxDepth; depth++) {
    const refs = collectRefs(current);
    if (refs.length === 0) break;

    // Cap refs per level to prevent abuse
    const capped = refs.slice(0, MAX_REFS_PER_LEVEL);

    // Split into tree refs, query refs, and document refs
    const treeRefs: RefPointer[] = [];
    const queryRefs: RefPointer[] = [];
    const docRefs: RefPointer[] = [];
    for (const ref of capped) {
      const seenKey = ref.isTree
        ? `${ref.collection}:${ref.treePath}`
        : ref.isQuery
          ? `${ref.collection}:${ref.queryWhere ?? ""}:${JSON.stringify(ref.queryQ ?? "")}`
          : (ref.id ? `${ref.collection}:${ref.id}` : `${ref.collection}:key:${ref.key}`);
      const above = ancestorsOf(ref.path);
      if (above.has(seenKey)) {
        setAtPath(current, ref.path, { $circular: true, $ref: ref.collection });
        continue;
      }
      ancestry.set(JSON.stringify(ref.path), new Set([...above, seenKey]));
      const ar = await canRead(ref.isTree ? `tree:${ref.treeName}` : `collection:${ref.isQuery ? ref.queryCollection : ref.collection}`);
      if (!ar.allowed || ar.filterExpr) {
        setAtPath(current, ref.path, { $ref: ref.collection, $forbidden: true });
        continue;
      }
      ref.label = ar.labelFilter ?? label;
      if (ref.isTree) treeRefs.push(ref);
      else if (ref.isQuery) queryRefs.push(ref);
      else docRefs.push(ref);
    }

    // ── Resolve tree refs ──
    // Each tree ref becomes an array of { path, documentId, data } nodes.
    for (const ref of treeRefs) {
      const treeName = ref.treeName!;
      const treePath = ref.treePath ?? "/";
      const limit = ref.treeLimit ?? DEFAULT_TREE_REF_LIMIT;

      const refLabel = ref.label;
      const nodes = await withTenant(schemaName, async tx => {
        const prefix = (treePath === "/" ? "/" : likeEscape(treePath.replace(/\/$/, "")) + "/") + "%";
        if (refLabel) {
          return tx<{ path: string; document_id: string; data: unknown }[]>`
            SELECT p.path, p.document_id, v.data
            FROM paths p
            JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
            JOIN labels l ON l.document_id = d.id AND l.label = ${refLabel}
            JOIN versions v ON v.document_id = d.id AND v.version = l.version
            WHERE p.tree = ${treeName}
              AND (p.path = ${treePath} OR p.path LIKE ${prefix})
            ORDER BY p.path
            LIMIT ${limit}
          `;
        }
        return tx<{ path: string; document_id: string; data: unknown }[]>`
          SELECT p.path, p.document_id, v.data
          FROM paths p
          JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
          JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
          WHERE p.tree = ${treeName}
            AND (p.path = ${treePath} OR p.path LIKE ${prefix})
          ORDER BY p.path
          LIMIT ${limit}
        `;
      });
      setAtPath(current, ref.path, nodes.map(n => ({ path: n.path, documentId: n.document_id, data: n.data })));
    }

    // ── Resolve query refs ──
    // Each query ref executes a _query call and inlines the result (items or rows).
    for (const ref of queryRefs) {
      const collection = ref.queryCollection!;
      const queryBody: Record<string, unknown> = {};
      if (ref.queryQ) {
        // Full query body (aggregation etc.)
        Object.assign(queryBody, ref.queryQ as Record<string, unknown>);
      }
      if (ref.querySelect) queryBody.select = ref.querySelect;
      if (ref.queryWhere) queryBody.where = ref.queryWhere;
      if (ref.queryLabel || ref.label) queryBody.label = ref.queryLabel ?? ref.label;
      queryBody.limit = ref.queryLimit ?? 20;

      try {
        const fakeReq = new Request("http://localhost/_query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(queryBody),
        });
        const queryResponse = await handleQuery(schemaName, collection, fakeReq, await canRead(`collection:${collection}`));
        const result = await queryResponse.json() as Record<string, unknown>;
        // Inline either rows (aggregate) or items (projection) — or the full result if neither
        setAtPath(current, ref.path, result.rows ?? result.items ?? result);
      } catch (e) {
        setAtPath(current, ref.path, { $ref: ref.collection, $error: String(e) });
      }
    }

    // ── Resolve document refs ──
    // Group by collection for batch fetching
    const byCollection = new Map<string, RefPointer[]>();
    for (const ref of docRefs) {
      const group = JSON.stringify([ref.collection, ref.label ?? null]);
      if (!byCollection.has(group)) byCollection.set(group, []);
      byCollection.get(group)!.push(ref);
    }

    for (const colRefs of byCollection.values()) {
      const { collection, label } = colRefs[0];
      const idRefs = colRefs.filter(r => r.id);
      const keyRefs = colRefs.filter(r => r.key);

      const resolved = new Map<string, unknown>();

      if (idRefs.length > 0) {
        const ids = idRefs.map(r => r.id!);
        const rows = await withTenant(schemaName, async tx => {
          if (label) {
            return tx<{ id: string; data: unknown }[]>`
              SELECT d.id, v.data FROM documents d
              JOIN labels l ON l.document_id = d.id AND l.label = ${label}
              JOIN versions v ON v.document_id = d.id AND v.version = l.version
              WHERE d.id = ANY(${ids}) AND d.collection = ${collection} AND d.deleted_at IS NULL
            `;
          }
          return tx<{ id: string; data: unknown }[]>`
            SELECT d.id, v.data FROM documents d
            JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
            WHERE d.id = ANY(${ids}) AND d.collection = ${collection} AND d.deleted_at IS NULL
          `;
        });
        for (const row of rows) resolved.set(`id:${row.id}`, row.data);
      }

      if (keyRefs.length > 0) {
        const keys = keyRefs.map(r => r.key!);
        const rows = await withTenant(schemaName, async tx => {
          if (label) {
            return tx<{ natural_key: string; data: unknown }[]>`
              SELECT d.natural_key, v.data FROM documents d
              JOIN labels l ON l.document_id = d.id AND l.label = ${label}
              JOIN versions v ON v.document_id = d.id AND v.version = l.version
              WHERE d.natural_key = ANY(${keys}) AND d.collection = ${collection} AND d.deleted_at IS NULL
            `;
          }
          return tx<{ natural_key: string; data: unknown }[]>`
            SELECT d.natural_key, v.data FROM documents d
            JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
            WHERE d.natural_key = ANY(${keys}) AND d.collection = ${collection} AND d.deleted_at IS NULL
          `;
        });
        for (const row of rows) resolved.set(`key:${row.natural_key}`, row.data);
      }

      for (const ref of colRefs) {
        const lookupKey = ref.id ? `id:${ref.id}` : `key:${ref.key}`;
        const data = resolved.get(lookupKey);
        if (data !== undefined) {
          setAtPath(current, ref.path, data);
        } else {
          setAtPath(current, ref.path, { $ref: ref.collection, $id: ref.id, $key: ref.key, $notFound: true });
        }
      }
    }
  }

  return current;
}

/**
 * Wrap a Response to resolve $ref objects if ?depth= is set.
 * Streams the response using chunked transfer encoding.
 */
async function withRefResolution(
  res: Response,
  schemaName: string,
  url: URL,
  label: string | undefined,
  access: RefAccess,
): Promise<Response> {
  const depthParam = url.searchParams.get("depth");
  if (!depthParam) return res;

  const depth = Math.min(Math.max(parseInt(depthParam) || 0, 0), MAX_REF_DEPTH);
  if (depth === 0) return res;

  const body = await res.json() as Record<string, unknown>;

  // Resolve refs in the data field (single doc) or in each item's data (list)
  if (body.data && typeof body.data === "object") {
    body.data = await resolveDocRefs(schemaName, body.data, depth, label, access);
  }
  if (Array.isArray(body.items)) {
    body.items = await Promise.all(
      (body.items as { data: unknown }[]).map(async item => ({
        ...item,
        data: await resolveDocRefs(schemaName, item.data, depth, label, access),
      }))
    );
  }

  // Stream the resolved response
  const json = JSON.stringify(body);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Stream in chunks for large resolved payloads
      const CHUNK_SIZE = 16384;
      for (let i = 0; i < json.length; i += CHUNK_SIZE) {
        controller.enqueue(encoder.encode(json.slice(i, i + CHUNK_SIZE)));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: res.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Transfer-Encoding": "chunked" },
  });
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
  // The version as an ETag: send it back as If-Match to make the next write conditional
  return Response.json({ id: row.id, version: row.version, collection, data: row.data, createdAt: row.created_at, updatedAt: row.updated_at, labels: row.labels },
    { headers: { ETag: `"${row.version}"` } });
}

/**
 * A write that changes nothing doesn't create a version: half of all updates in real
 * deployments were byte-identical re-sends (sync scripts, deploys, agents). The JSON is
 * compared by meaning (jsonb: key order and whitespace don't matter). `?force=true`
 * writes a version anyway. Returns the document's updated_at when unchanged.
 */
async function sameAsCurrent(tx: Sql, id: string, currentVersion: number, data: unknown): Promise<{ updated_at: Date } | null> {
  const [row] = await tx<{ same: boolean; updated_at: Date }[]>`
    SELECT v.data = ${tx.json(data as Parameters<typeof tx.json>[0])}::jsonb AS same, d.updated_at
    FROM versions v JOIN documents d ON d.id = v.document_id
    WHERE v.document_id = ${id} AND v.version = ${currentVersion}
  `;
  return row?.same ? { updated_at: row.updated_at } : null;
}

const forceWrite = (req: Request) => new URL(req.url).searchParams.get("force") === "true";

/**
 * Conditional writes: `If-Match: "<version>"` (as returned in a document's ETag) or
 * `?ifVersion=<n>` makes a write apply only if the document is still at that version —
 * so two clients that read-then-write the same document can't silently overwrite each
 * other. `0` means "only if it doesn't exist yet" (create-only, for upserts by key);
 * `If-Match: *` means "only if it exists". Returns null when the request has no
 * condition.
 */
type Expect = number | "exists" | null;
function expectedVersion(req: Request): Expect {
  const q = new URL(req.url).searchParams.get("ifVersion");
  const raw = (q ?? req.headers.get("if-match") ?? "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!raw) return null;
  if (raw === "*") return "exists";
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
}
/** True when the condition fails for a document at `current` (0 = doesn't exist). */
const conditionFails = (expect: Expect, current: number) =>
  expect !== null && (expect === "exists" ? current === 0 : expect !== current);
const versionMismatch = (current: number) => Response.json({
  error: "Version mismatch",
  details: current === 0 ? "The document doesn't exist (or no longer does)." : `The document is at version ${current} now; read it again and re-apply your change.`,
  currentVersion: current,
}, { status: 412 });

async function handleUpdate(schemaName: string, collection: string, id: string, req: Request, userId: string): Promise<Response> {
  const data = await req.json();
  const force = forceWrite(req);
  const expect = expectedVersion(req);

  const errors = await validateAgainstSchema(schemaName, collection, data);
  if (errors) return Response.json({ error: "Schema validation failed", details: errors }, { status: 422 });

  // Re-extract the natural key from incoming data. If the user changed the
  // key field inside data, this moves the column too — the unique index
  // enforces uniqueness and we map conflicts back to 409.
  const naturalKey = await extractNaturalKey(schemaName, collection, data);

  try {
    const result = await withTenant(schemaName, async tx => {
      const [doc] = await tx<{ id: string; current_version: number; natural_key: string | null }[]>`
        SELECT id, current_version, natural_key FROM documents
        WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!doc) return expect === null || expect === "exists" ? null : { mismatch: 0 };
      if (conditionFails(expect, doc.current_version)) return { mismatch: doc.current_version };

      // Same data as the current version: no new version (see sameAsCurrent). The
      // stored natural key still follows the data, e.g. after a naturalKey was added.
      const unchanged = !force && await sameAsCurrent(tx, id, doc.current_version, data);
      if (unchanged) {
        if (doc.natural_key !== naturalKey) await tx`UPDATE documents SET natural_key = ${naturalKey} WHERE id = ${id}`;
        return { version: doc.current_version, updated_at: unchanged.updated_at, unchanged: true };
      }

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
      return { version: newVersion, updated_at: updated.updated_at, unchanged: false };
    });

    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    if ("mismatch" in result) return versionMismatch(result.mismatch);
    return Response.json({ id, version: result.version, collection, data, naturalKey, ...(result.unchanged ? { unchanged: true } : {}), updatedAt: result.updated_at });
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

async function handleDelete(schemaName: string, collection: string, id: string, expect: Expect = null): Promise<Response> {
  const outcome = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!doc) return "missing" as const;
    if (conditionFails(expect, doc.current_version)) return doc.current_version;
    await tx`UPDATE documents SET deleted_at = NOW() WHERE id = ${id}`;
    return "deleted" as const;
  });

  if (outcome === "missing") return Response.json({ error: "Not found" }, { status: 404 });
  if (typeof outcome === "number") return versionMismatch(outcome);
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

  const expect = expectedVersion(req);
  try {
    const result = await withTenant(schemaName, async tx => {
      // Lookup-and-lock an existing doc with this key.
      const [existing] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM documents
        WHERE collection = ${collection} AND natural_key = ${keyValue} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (conditionFails(expect, existing?.current_version ?? 0)) return { mismatch: existing?.current_version ?? 0 };

      if (existing) {
        // Same data as the current version: nothing to write
        const unchanged = !forceWrite(req) && await sameAsCurrent(tx, existing.id, existing.current_version, payload);
        if (unchanged) {
          const [d] = await tx<{ created_at: Date }[]>`SELECT created_at FROM documents WHERE id = ${existing.id}`;
          return { id: existing.id, version: existing.current_version, created: false, unchanged: true, created_at: d.created_at, updated_at: unchanged.updated_at };
        }
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
        return { id: existing.id, version: newVersion, created: false, unchanged: false, created_at: updated.created_at, updated_at: updated.updated_at };
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
      return { id: inserted.id, version: 1, created: true, unchanged: false, created_at: inserted.created_at, updated_at: inserted.updated_at };
    });

    if ("mismatch" in result) return { res: versionMismatch(result.mismatch), id: null };
    return {
      res: Response.json(
        {
          id: result.id,
          version: result.version,
          collection,
          data: payload,
          naturalKey: keyValue,
          ...(result.unchanged ? { unchanged: true } : {}),
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
  expect: Expect = null,
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
  const res = await handleDelete(schemaName, collection, row.id, expect);
  return { res, id: row.id };
}

async function handleVersionList(schemaName: string, collection: string, id: string): Promise<Response> {
  const versions = await withTenant(schemaName, async tx => {
    // Verify doc exists
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;

    const rows = await tx<{ version: number; created_at: Date; created_by: string; impersonated_by: string | null; labels: string[] }[]>`
      SELECT v.version, v.created_at, v.created_by, v.impersonated_by,
             COALESCE(array_agg(l.label ORDER BY l.label) FILTER (WHERE l.label IS NOT NULL), '{}') AS labels
      FROM versions v
      LEFT JOIN labels l ON l.document_id = v.document_id AND l.version = v.version
      WHERE v.document_id = ${id}
      GROUP BY v.version, v.created_at, v.created_by, v.impersonated_by
      ORDER BY v.version ASC
    `;
    // impersonatedBy: the org admin who made this change while acting as createdBy
    return rows.map(r => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by, impersonatedBy: r.impersonated_by, labels: r.labels }));
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
        AND d.collection = ${collection} AND d.deleted_at IS NULL
    `;
    return rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, version, data: row.data, createdAt: row.created_at });
}

/**
 * Make an older version's content the document's new current version: history moves
 * forward (version n+1 = content of `targetVersion`). A file version keeps pointing at
 * the same blob, and the natural key follows the restored data. Returns the new
 * version, or null if the target version doesn't exist.
 */
async function restoreVersion(tx: Sql, collection: string, id: string, currentVersion: number, targetVersion: number, userId: string): Promise<number | null> {
  const [target] = await tx<{ data: Record<string, unknown> }[]>`
    SELECT data FROM versions WHERE document_id = ${id} AND version = ${targetVersion}
  `;
  if (!target) return null;
  const [schema] = await tx<{ natural_key: string | null }[]>`
    SELECT natural_key FROM collection_schemas WHERE collection = ${collection}
  `;
  const keyField = schema?.natural_key ?? null;
  const keyValue = keyField && typeof target.data?.[keyField] === "string" ? (target.data[keyField] as string).trim() : null;
  const version = currentVersion + 1;
  await tx`
    INSERT INTO versions (document_id, version, data, created_by)
    VALUES (${id}, ${version}, ${tx.json(target.data)}, ${userId})
  `;
  await tx`
    INSERT INTO asset_contents (document_id, version, sha256, mime_type, filename, size)
    SELECT document_id, ${version}, sha256, mime_type, filename, size
    FROM asset_contents WHERE document_id = ${id} AND version = ${targetVersion}
  `;
  await tx`
    UPDATE documents SET current_version = ${version}, updated_at = NOW(),
      natural_key = CASE WHEN ${keyField}::text IS NULL THEN natural_key ELSE ${keyValue} END
    WHERE id = ${id}
  `;
  return version;
}

async function handleRollback(schemaName: string, collection: string, id: string, versionStr: string, userId: string): Promise<Response> {
  const targetVersion = parseInt(versionStr, 10);
  if (isNaN(targetVersion)) return Response.json({ error: "Invalid version" }, { status: 400 });

  try {
    const result = await withTenant(schemaName, async tx => {
      const [doc] = await tx<{ current_version: number }[]>`
        SELECT current_version FROM documents
        WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!doc) return null;
      const newVersion = await restoreVersion(tx, collection, id, doc.current_version, targetVersion, userId);
      return newVersion === null ? null : { newVersion, rolledBackTo: targetVersion };
    });
    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ id, version: result.newVersion, rolledBackTo: result.rolledBackTo });
  } catch (err) {
    if (isNaturalKeyConflict(err)) return Response.json({ error: "Natural key conflict", details: "Another document already has the natural key of the version you're rolling back to." }, { status: 409 });
    throw err;
  }
}

/** POST /{collection}/{id}/undelete — bring back a deleted document as it was. */
async function handleUndelete(schemaName: string, collection: string, id: string): Promise<Response> {
  try {
    const rows = await withTenant(schemaName, tx => tx<{ current_version: number }[]>`
      UPDATE documents SET deleted_at = NULL, updated_at = NOW()
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NOT NULL
      RETURNING current_version
    `);
    if (!rows.length) return Response.json({ error: "No deleted document with that id in this collection" }, { status: 404 });
    return Response.json({ id, undeleted: true, version: rows[0].current_version });
  } catch (err) {
    if (isNaturalKeyConflict(err)) return Response.json({ error: "Natural key conflict", details: "Another document now has this document's natural key." }, { status: 409 });
    throw err;
  }
}

/** DELETE /{collection}/{id}/labels/{label} */
async function handleRemoveLabel(schemaName: string, collection: string, id: string, label: string): Promise<Response> {
  const rows = await withTenant(schemaName, tx => tx<{ version: number }[]>`
    DELETE FROM labels l USING documents d
    WHERE l.document_id = d.id AND d.id = ${id} AND d.collection = ${collection} AND d.deleted_at IS NULL
      AND l.label = ${label}
    RETURNING l.version
  `);
  if (!rows.length) return Response.json({ error: "No such label on this document" }, { status: 404 });
  return Response.json({ id, label, removed: true, version: rows[0].version });
}

type RestoreScope = { collection: string } | { tree: string };

/**
 * Restore every document of a collection or tree to the version a label points at, in
 * one transaction: changed documents get a new version with the labeled content,
 * deleted ones come back, and with deleteUnlabeled documents without the label (made
 * since) are deleted. Returns what happened, or a Response for errors.
 */
async function restoreToLabel(schemaName: string, scope: RestoreScope, req: Request, userId: string): Promise<{ result: { label: string; restored: number; undeleted: number; deleted: number; unchanged: number; collections: string[] } } | { error: Response }> {
  const body = await req.json().catch(() => ({})) as { label?: unknown; deleteUnlabeled?: unknown };
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return { error: Response.json({ error: "label is required" }, { status: 400 }) };
  const deleteUnlabeled = body.deleteUnlabeled === true;
  const inScope = (tx: Sql) => "collection" in scope
    ? tx`d.collection = ${scope.collection}`
    : tx`d.id IN (SELECT document_id FROM paths WHERE tree = ${scope.tree} AND document_id IS NOT NULL)`;
  try {
    const result = await withTenant(schemaName, async tx => {
      const docs = await tx<{ id: string; collection: string; current_version: number; deleted: boolean; label_version: number; same: boolean }[]>`
        SELECT d.id, d.collection, d.current_version, d.deleted_at IS NOT NULL AS deleted, l.version AS label_version,
               -- the current content already equals the labeled one (file metadata includes the hash)
               (SELECT cv.data = lv.data FROM versions cv, versions lv
                 WHERE cv.document_id = d.id AND cv.version = d.current_version
                   AND lv.document_id = d.id AND lv.version = l.version) AS same
        FROM documents d JOIN labels l ON l.document_id = d.id AND l.label = ${label}
        WHERE ${inScope(tx)} AND d.collection NOT LIKE '\\_%'
        ORDER BY d.id
        FOR UPDATE OF d
      `;
      let restored = 0, undeleted = 0, unchanged = 0;
      const touched = new Set<string>();
      for (const d of docs) {
        if (d.deleted) {
          await tx`UPDATE documents SET deleted_at = NULL, updated_at = NOW() WHERE id = ${d.id}`;
          undeleted++; touched.add(d.collection);
        }
        if (d.current_version !== d.label_version && !d.same) {
          await restoreVersion(tx, d.collection, d.id, d.current_version, d.label_version, userId);
          restored++; touched.add(d.collection);
        } else if (!d.deleted) unchanged++;
      }
      let deleted = 0;
      if (deleteUnlabeled) {
        const gone = await tx<{ collection: string }[]>`
          UPDATE documents d SET deleted_at = NOW()
          WHERE ${inScope(tx)} AND d.collection NOT LIKE '\\_%' AND d.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.document_id = d.id AND l.label = ${label})
          RETURNING d.collection
        `;
        deleted = gone.length;
        gone.forEach(g => touched.add(g.collection));
      }
      return { label, restored, undeleted, deleted, unchanged, collections: [...touched].sort() };
    });
    if (result.restored + result.undeleted + result.unchanged === 0 && result.deleted === 0) {
      return { error: Response.json({ error: `No document here has the label "${label}"` }, { status: 404 }) };
    }
    return { result };
  } catch (err) {
    if (isNaturalKeyConflict(err)) {
      return { error: Response.json({ error: "Natural key conflict", details: "Restoring would give two live documents the same natural key; nothing was changed." }, { status: 409 }) };
    }
    throw err;
  }
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
        SET version = EXCLUDED.version, updated_at = NOW(),
            impersonated_by = EXCLUDED.impersonated_by -- who moved it last (column default)
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
    tx<{ schema: unknown; display_name: string | null; collection_type: string; list_columns: string[] | null; natural_key: string | null; indexes: unknown; updated_at: Date }[]>`
      SELECT schema, display_name, collection_type, list_columns, natural_key, COALESCE(indexes, '[]'::jsonb) AS indexes, updated_at FROM collection_schemas WHERE collection = ${collection}
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
    indexes:        rows[0].indexes ?? [],
    updatedAt:      rows[0].updated_at,
  });
}

/**
 * PATCH /{collection}/_schema — change only the fields sent ({naturalKey}, {listColumns},
 * …); everything else stays as it is. `null` clears a field. PUT replaces the whole
 * definition, so a script that PUTs its schema on every run would silently drop a
 * naturalKey or index someone added later; PATCH doesn't.
 */
async function handlePatchSchema(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const FIELDS = ["schema", "displayName", "collectionType", "listColumns", "naturalKey", "indexes"];
  const body = await req.json() as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Send a JSON object with the fields to change" }, { status: 400 });
  const unknown = Object.keys(body).filter(k => !FIELDS.includes(k));
  if (unknown.length) return Response.json({ error: `Unknown field(s): ${unknown.join(", ")}. Allowed: ${FIELDS.join(", ")}` }, { status: 400 });
  const current = await handleGetSchema(schemaName, collection);
  const base: Record<string, unknown> = current.ok
    ? await current.json() as Record<string, unknown>
    : { schema: {}, displayName: null, collectionType: "json", listColumns: null, naturalKey: null, indexes: [] };
  const merged: Record<string, unknown> = {};
  for (const f of FIELDS) merged[f] = f in body ? body[f] : base[f];
  if (merged.schema === null) merged.schema = {};
  // Reuse PUT's validation and side effects (indexes, natural-key registration)
  const put = new Request(req.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(merged) });
  return handleSetSchema(schemaName, collection, put, userId);
}

// Index declaration types and helpers
interface IndexDeclaration {
  path: string;
  kind: "btree" | "gin" | "trigram";
}

const VALID_INDEX_KINDS = new Set(["btree", "gin", "trigram"]);
const MAX_INDEXES = 10;

function validateIndexDeclarations(raw: unknown): IndexDeclaration[] {
  if (!Array.isArray(raw)) throw new Error("indexes must be an array");
  if (raw.length > MAX_INDEXES) throw new Error(`Maximum ${MAX_INDEXES} indexes per collection`);
  return raw.map((item: unknown) => {
    const i = item as Record<string, unknown>;
    if (!i.path || typeof i.path !== "string") throw new Error("Each index needs a path");
    if (!i.kind || !VALID_INDEX_KINDS.has(i.kind as string)) throw new Error(`Invalid index kind: ${i.kind}. Must be btree, gin, or trigram`);
    if (!SAFE_PATH.test(i.path) && !SAFE_ARRAY_PATH.test(i.path)) throw new Error(`Invalid index path: ${i.path}`);
    return { path: i.path as string, kind: i.kind as IndexDeclaration["kind"] };
  });
}

function indexName(collection: string, idx: IndexDeclaration): string {
  // Create a deterministic, safe index name from collection + path + kind
  const hash = collection.replace(/[^a-z0-9]/gi, "_") + "_" +
    idx.path.replace(/[^a-z0-9]/gi, "_") + "_" + idx.kind;
  return `idx_q_${hash}`.slice(0, 63); // Postgres name limit
}

function buildIndexDDL(collection: string, idx: IndexDeclaration, name: string): string {
  const segments = idx.path.replace(/\[\]/g, "").split(".");
  const jsonExpr = segments.length === 1
    ? `(data->>'${segments[0]}')`
    : `(data #>> '{${segments.join(",")}}')`;
  const jsonbExpr = segments.length === 1
    ? `(data->'${segments[0]}')`
    : `(data #> '{${segments.join(",")}}')`;

  // Simple indexes on the versions table — no partial WHERE (avoids subquery issues)
  switch (idx.kind) {
    case "btree":
      return `CREATE INDEX IF NOT EXISTS "${name}" ON versions (${jsonExpr})`;
    case "gin":
      return `CREATE INDEX IF NOT EXISTS "${name}" ON versions USING GIN (${jsonbExpr} jsonb_path_ops)`;
    case "trigram":
      return `CREATE INDEX IF NOT EXISTS "${name}" ON versions USING GIN (${jsonExpr} gin_trgm_ops)`;
  }
}

async function reconcileIndexes(
  schemaName: string,
  collection: string,
  current: IndexDeclaration[],
  desired: IndexDeclaration[],
): Promise<void> {
  const toCreate = desired.filter(d => !current.some(c => c.path === d.path && c.kind === d.kind));
  const toDrop = current.filter(c => !desired.some(d => d.path === c.path && d.kind === c.kind));

  for (const idx of toDrop) {
    const name = indexName(collection, idx);
    try { await sql.unsafe(`DROP INDEX IF EXISTS ${schemaName}.${name}`); }
    catch (e) { console.error(`[index] failed to drop ${name}:`, e); }
  }
  for (const idx of toCreate) {
    const name = indexName(collection, idx);
    const ddl = buildIndexDDL(collection, idx, name);
    try {
      // One transaction, so the search_path applies to the DDL's connection and
      // ends with it (a plain SET would stick to a pooled connection).
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL search_path TO ${schemaName}, common, public`);
        if (idx.kind === "trigram") await tx.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await tx.unsafe(ddl);
      });
    } catch (e) { console.error(`[index] failed to create ${name}:`, String(e).slice(0, 200)); }
  }
}

async function handleSetSchema(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  // Accept either a plain JSON Schema or a wrapper { schema?, displayName?, collectionType?, listColumns?, naturalKey?, indexes? }
  const isWrapper = body && typeof body === "object" && ("schema" in body || "collectionType" in body || "displayName" in body || "listColumns" in body || "naturalKey" in body || "indexes" in body);
  const collectionType: string =
    (isWrapper && typeof body.collectionType === "string") ? body.collectionType : "json";
  const schema = collectionType === "binary"
    ? {}
    : (isWrapper ? body.schema : body) ?? {};
  const displayName: string | null =
    (isWrapper && typeof body.displayName === "string") ? body.displayName : null;
  const listColumns: string[] | null =
    (isWrapper && Array.isArray(body.listColumns) && body.listColumns.length > 0)
      ? (body.listColumns as string[]).filter(c => typeof c === "string" && c.trim())
      : null;
  const naturalKey: string | null =
    (isWrapper && typeof body.naturalKey === "string" && body.naturalKey.trim())
      ? body.naturalKey.trim()
      : null;

  // Index declarations
  let indexes: IndexDeclaration[] = [];
  if (isWrapper && "indexes" in body) {
    try { indexes = validateIndexDeclarations(body.indexes); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  }

  if (collectionType !== "binary") {
    try { ajv.compile(schema as object); }
    catch (e) { return Response.json({ error: "Invalid JSON Schema", details: String(e) }, { status: 422 }); }
  }

  // Get current indexes before upsert (for reconciliation)
  let currentIndexes: IndexDeclaration[] = [];
  if (isWrapper && "indexes" in body) {
    try {
      const rows = await withTenant(schemaName, async tx =>
        tx<{ indexes: IndexDeclaration[] }[]>`SELECT COALESCE(indexes, '[]'::jsonb) AS indexes FROM collection_schemas WHERE collection = ${collection}`
      );
      currentIndexes = rows[0]?.indexes ?? [];
    } catch { /* collection doesn't exist yet */ }
  }

  let keysRegistered = 0;
  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO collection_schemas (collection, schema, display_name, collection_type, list_columns, natural_key, indexes, created_by)
      VALUES (${collection}, ${tx.json(schema)}, ${displayName}, ${collectionType}, ${listColumns}, ${naturalKey}, ${tx.json(indexes)}, ${userId})
      ON CONFLICT (collection) DO UPDATE
        SET schema          = EXCLUDED.schema,
            display_name    = EXCLUDED.display_name,
            collection_type = EXCLUDED.collection_type,
            list_columns    = EXCLUDED.list_columns,
            natural_key     = EXCLUDED.natural_key,
            indexes         = EXCLUDED.indexes,
            updated_at      = NOW()
    `;
    if (naturalKey) keysRegistered = await registerNaturalKeys(tx, collection, naturalKey);
  });

  // Reconcile Postgres indexes outside the transaction (CREATE INDEX CONCURRENTLY can't run inside one)
  if (isWrapper && "indexes" in body) {
    reconcileIndexes(schemaName, collection, currentIndexes, indexes).catch(e => {
      console.error("[index] reconciliation failed:", e);
    });
  }

  naturalKeyCache.delete(`${schemaName}:${collection}`);
  return Response.json({ collection, collectionType, schema: collectionType === "binary" ? null : schema, displayName, listColumns, naturalKey, indexes, ...(naturalKey ? { keysRegistered } : {}) });
}

/**
 * When a collection gets a natural key, its existing documents get theirs from their
 * current data, so by-key reads and upserts find them (instead of creating duplicates).
 * If two live documents would share a key, nothing changes and the request is refused.
 */
async function registerNaturalKeys(tx: Sql, collection: string, field: string): Promise<number> {
  const clashes = await tx<{ key: string; n: number }[]>`
    SELECT btrim(v.data->>${field}) AS key, count(*)::int AS n
    FROM documents d JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
    WHERE d.collection = ${collection} AND d.deleted_at IS NULL
      AND jsonb_typeof(v.data->${field}) = 'string' AND btrim(v.data->>${field}) <> ''
    GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT 20
  `;
  if (clashes.length) {
    throw new HttpError(409, `Can't use '${field}' as the natural key: several documents share the same value (${clashes.map(c => `'${c.key}' ×${c.n}`).join(", ")}). Make them unique first; nothing was changed.`);
  }
  const updated = await tx`
    UPDATE documents d
    SET natural_key = CASE WHEN jsonb_typeof(v.data->${field}) = 'string' AND btrim(v.data->>${field}) <> ''
                           THEN btrim(v.data->>${field}) END
    FROM versions v
    WHERE v.document_id = d.id AND v.version = d.current_version
      AND d.collection = ${collection} AND d.deleted_at IS NULL
      AND d.natural_key IS DISTINCT FROM
          CASE WHEN jsonb_typeof(v.data->${field}) = 'string' AND btrim(v.data->>${field}) <> '' THEN btrim(v.data->>${field}) END
  `;
  return updated.count;
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

// ── Materialized queries ─────────────────────────────────────────────────────

const MAX_MATERIALIZED_PER_COLLECTION = 5;

async function handleListMaterialized(schemaName: string, collection: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ name: string; refresh_on: string; result_doc_id: string | null; created_at: Date; updated_at: Date }[]>`
      SELECT name, refresh_on, result_doc_id, created_at, updated_at
      FROM materialized_queries WHERE collection = ${collection} ORDER BY name
    `
  );
  return Response.json({
    collection,
    materialized: rows.map(r => ({
      name: r.name, refreshOn: r.refresh_on, resultDocId: r.result_doc_id,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}

async function handleGetMaterialized(schemaName: string, collection: string, name: string): Promise<Response> {
  const mq = await withTenant(schemaName, async tx => {
    const rows = await tx<{ result_doc_id: string | null }[]>`
      SELECT result_doc_id FROM materialized_queries WHERE collection = ${collection} AND name = ${name}
    `;
    return rows[0] ?? null;
  });
  if (!mq) return Response.json({ error: "Not found" }, { status: 404 });
  if (!mq.result_doc_id) return Response.json({ error: "Materialized query has no result yet" }, { status: 404 });

  // Read the result document
  const doc = await withTenant(schemaName, async tx => {
    const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>`
      SELECT d.id, d.current_version AS version, v.data, d.created_at, d.updated_at
      FROM documents d
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.id = ${mq.result_doc_id} AND d.deleted_at IS NULL
    `;
    return rows[0] ?? null;
  });
  if (!doc) return Response.json({ error: "Result document not found" }, { status: 404 });

  return Response.json({
    collection, name,
    result: { id: doc.id, version: doc.version, data: doc.data, createdAt: doc.created_at, updatedAt: doc.updated_at },
  });
}

async function handleSetMaterialized(
  schemaName: string, collection: string, name: string, req: Request, userId: string,
): Promise<Response> {
  const body = await req.json() as { query: QueryRequest; refreshOn?: string };
  if (!body.query) return Response.json({ error: "query is required" }, { status: 400 });
  const refreshOn = body.refreshOn ?? "write";
  if (!["write", "manual"].includes(refreshOn)) {
    return Response.json({ error: "refreshOn must be 'write' or 'manual'" }, { status: 400 });
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    return Response.json({ error: "Invalid materialized query name" }, { status: 400 });
  }

  // Check limit
  const existing = await withTenant(schemaName, async tx =>
    tx<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM materialized_queries WHERE collection = ${collection}`
  );
  if (parseInt(existing[0]?.count ?? "0") >= MAX_MATERIALIZED_PER_COLLECTION) {
    const mq = await withTenant(schemaName, async tx =>
      tx<{ id: string }[]>`SELECT id FROM materialized_queries WHERE collection = ${collection} AND name = ${name}`
    );
    if (!mq.length) {
      return Response.json({ error: `Maximum ${MAX_MATERIALIZED_PER_COLLECTION} materialized queries per collection` }, { status: 400 });
    }
  }

  // Create or reuse the result document
  let resultDocId: string;
  const mqRow = await withTenant(schemaName, async tx => {
    const rows = await tx<{ result_doc_id: string | null }[]>`
      SELECT result_doc_id FROM materialized_queries WHERE collection = ${collection} AND name = ${name}
    `;
    return rows[0] ?? null;
  });

  if (mqRow?.result_doc_id) {
    resultDocId = mqRow.result_doc_id;
  } else {
    // Create a placeholder document in a synthetic collection
    const syntheticCollection = `${collection}/_materialized`;
    const doc = await withTenant(schemaName, async tx => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO documents (collection, current_version, created_by)
        VALUES (${syntheticCollection}, 0, ${userId})
        RETURNING id
      `;
      return row;
    });
    resultDocId = doc.id;
  }

  // Upsert the materialized query definition
  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO materialized_queries (collection, name, query, refresh_on, result_doc_id, created_by)
      VALUES (${collection}, ${name}, ${tx.json(body.query)}, ${refreshOn}, ${resultDocId}, ${userId})
      ON CONFLICT (collection, name) DO UPDATE
        SET query = EXCLUDED.query,
            refresh_on = EXCLUDED.refresh_on,
            result_doc_id = COALESCE(materialized_queries.result_doc_id, EXCLUDED.result_doc_id),
            updated_at = NOW()
    `;
  });

  // Execute the query immediately to populate the first result
  refreshMaterializedQuery(schemaName, collection, name, userId).catch(e => {
    console.error(`[materialized] initial refresh of ${collection}/${name} failed:`, e);
  });

  return Response.json({ collection, name, refreshOn, resultDocId }, { status: 200 });
}

async function handleDeleteMaterialized(schemaName: string, collection: string, name: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ id: string }[]>`
      DELETE FROM materialized_queries WHERE collection = ${collection} AND name = ${name} RETURNING id
    `
  );
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ collection, name, deleted: true });
}

/**
 * Execute a materialized query's definition and store the result as a new version
 * of its result document.
 */
async function refreshMaterializedQuery(
  schemaName: string, sourceCollection: string, name: string, userId: string,
): Promise<void> {
  const mq = await withTenant(schemaName, async tx => {
    const rows = await tx<{ query: QueryRequest; result_doc_id: string }[]>`
      SELECT query, result_doc_id FROM materialized_queries
      WHERE collection = ${sourceCollection} AND name = ${name} AND result_doc_id IS NOT NULL
    `;
    return rows[0] ?? null;
  });
  if (!mq) return;

  // Execute the query using the same engine as handleQuery — reuse it by
  // constructing a synthetic POST request. This ensures aggregate, where,
  // select all work identically to the live _query endpoint.
  const fakeReq = new Request("http://localhost/_query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...mq.query, limit: Math.min(mq.query.limit ?? 10000, 10000) }),
  });
  const noPermFilter: AccessResult = { allowed: true, auditReads: false, auditWrites: false };
  const queryResponse = await handleQuery(schemaName, sourceCollection, fakeReq, noPermFilter);
  const resultData = { ...(await queryResponse.json() as Record<string, unknown>), refreshedAt: new Date().toISOString() };
  await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents WHERE id = ${mq.result_doc_id}
    `;
    const newVersion = (doc?.current_version ?? 0) + 1;
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${mq.result_doc_id}, ${newVersion}, ${tx.json(resultData)}, ${userId})
    `;
    await tx`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
      WHERE id = ${mq.result_doc_id}
    `;
  });
}

/**
 * Fire-and-forget: refresh all materialized queries for a collection after a write.
 */
async function refreshMaterializedForCollection(
  schemaName: string, collection: string, userId: string,
): Promise<void> {
  const mqs = await withTenant(schemaName, async tx =>
    tx<{ name: string }[]>`
      SELECT name FROM materialized_queries WHERE collection = ${collection} AND refresh_on = 'write'
    `
  );
  for (const mq of mqs) {
    try {
      await refreshMaterializedQuery(schemaName, collection, mq.name, userId);
    } catch (e) {
      console.error(`[materialized] refresh of ${collection}/${mq.name} failed:`, e);
    }
  }
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
  // v1/v2: a version number, or a label name (resolved to the version it points at)
  const resolve = async (raw: string | null): Promise<number | null | "missing"> => {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const [row] = await withTenant(schemaName, tx => tx<{ version: number }[]>`
      SELECT l.version FROM labels l JOIN documents d ON d.id = l.document_id
      WHERE l.document_id = ${id} AND d.collection = ${collection} AND l.label = ${raw}
    `);
    return row ? row.version : "missing";
  };
  const r1 = await resolve(url.searchParams.get("v1")), r2 = await resolve(url.searchParams.get("v2"));
  if (r1 === null || r2 === null) return Response.json({ error: "v1 and v2 are required (a version number or a label)" }, { status: 400 });
  if (r1 === "missing" || r2 === "missing") return Response.json({ error: "No such label on this document" }, { status: 404 });
  const v1 = r1, v2 = r2;
  const deep = url.searchParams.get("deep") === "true";

  const result = await withTenant(schemaName, async tx => {
    const rows = await tx<{ version: number; data: Record<string, unknown> }[]>`
      SELECT v.version, v.data
      FROM versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = ${id} AND v.version IN (${v1}, ${v2})
        AND d.collection = ${collection} AND d.deleted_at IS NULL
      ORDER BY v.version
    `;
    if (rows.length < 2) return null;
    const byVersion = Object.fromEntries(rows.map(r => [r.version, r.data]));
    return { before: byVersion[v1], after: byVersion[v2] };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, v1, v2, diff: computeDiff(result.before, result.after, deep) });
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

// Return true when the response should be raw file bytes rather than the JSON
// metadata envelope. The default is raw — callers who want metadata must send
// `Accept: application/json` explicitly.
//
// This matches what every other static-file host does (S3, R2, Vercel, Netlify,
// jsdelivr, GitHub raw). Without it, `<script src="…/tree/foo.js">`,
// `<link href="…/tree/foo.css">`, `<img src="…/tree/foo.png">`, and ESM
// `import './bar.js'` all break because browsers send `Accept: */*` and get
// the JSON envelope instead of the file content.
function shouldServeBinary(accept: string | null): boolean {
  if (!accept) return true;
  const types = accept.split(",").map(p => p.trim().split(";")[0].trim());
  const hasJson = types.some(t => t === "application/json");
  // Explicit application/json → metadata envelope. Everything else → raw bytes.
  return !hasJson;
}

async function handleTreeGet(schemaName: string, treeName: string, treePath: string, accept?: string | null, label?: string): Promise<Response> {
  const result = await withTenant(schemaName, async tx => {
    // Exact match at this path in this tree
    const [exact] = await tx<{ document_id: string; assignment_doc_id: string | null }[]>`
      SELECT document_id, assignment_doc_id FROM paths WHERE tree = ${treeName} AND path = ${treePath}
    `;

    // Everything below this path (all depths: a deep path needn't have a row for
    // each folder above it)
    const prefix = likeEscape(treePath.replace(/\/$/, "")) + "/";
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

  // 404 if nothing is visible here: the path doesn't exist (or its document has no
  // version under the requested/enforced label, e.g. deployed but not yet promoted)
  // AND there are no descendants.
  // no-store: otherwise the CDN keeps serving the 404 after the file is deployed.
  if ((!result.pathExists || !result.document) && result.children.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
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

// POST /api/v1/tree/{name}/_promote  {label?: "published", from?: "preview"}
// Points `label` at a version of every document in the tree in ONE transaction, so
// visitors never see a half-promoted site and a failure changes nothing.
// Version per document: the version carrying `from` if given (documents without it
// are left alone), otherwise the current version.
async function handleTreePromote(
  schemaName: string, treeName: string, req: Request, userId: string,
  canWrite: (collection: string) => Promise<boolean>,
): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { label?: unknown; from?: unknown };
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "published";
  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : null;

  try {
    const promoted = await withTenant(schemaName, async tx => {
      const rows = from
        ? await tx<{ path: string; id: string; collection: string; version: number }[]>`
            SELECT DISTINCT ON (d.id) p.path, d.id, d.collection, l.version
            FROM paths p
            JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
            JOIN labels l ON l.document_id = d.id AND l.label = ${from}
            WHERE p.tree = ${treeName}
            ORDER BY d.id, p.path
          `
        : await tx<{ path: string; id: string; collection: string; version: number }[]>`
            SELECT DISTINCT ON (d.id) p.path, d.id, d.collection, d.current_version AS version
            FROM paths p
            JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
            WHERE p.tree = ${treeName}
            ORDER BY d.id, p.path
          `;

      for (const col of new Set(rows.map(r => r.collection))) {
        if (!(await canWrite(col))) throw new PromoteError(403, `No write access to collection '${col}'`);
      }

      for (const r of rows) {
        await tx`
          INSERT INTO labels (document_id, label, version, created_by)
          VALUES (${r.id}, ${label}, ${r.version}, ${userId})
          ON CONFLICT (document_id, label) DO UPDATE
            SET version = EXCLUDED.version, updated_at = NOW(),
            impersonated_by = EXCLUDED.impersonated_by -- who moved it last (column default)
        `;
      }
      return rows.map(r => ({ path: r.path, documentId: r.id, collection: r.collection, version: r.version }));
    });

    if (promoted.length === 0) {
      return Response.json({ error: from ? `No documents in tree '${treeName}' carry label '${from}'` : `Tree '${treeName}' is empty` }, { status: 404 });
    }
    return Response.json({ tree: treeName, label, from, promoted });
  } catch (e) {
    if (e instanceof PromoteError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

class PromoteError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
      if (!doc) throw new HttpError(404, "Document not found");
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
              assignment_doc_id = EXCLUDED.assignment_doc_id,
              impersonated_by = EXCLUDED.impersonated_by
      `;
    } else {
      // Create an empty folder or unassign a document (clear document_id)
      await tx`
        INSERT INTO paths (document_id, tree, path)
        VALUES (${null}, ${treeName}, ${treePath})
        ON CONFLICT (tree, path) DO UPDATE
          SET document_id = NULL, impersonated_by = EXCLUDED.impersonated_by
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
  if (!(await isOrgMember(userId, orgId))) return Response.json({ error: "Forbidden" }, { status: 403 });
  // Admins see every key in the org; members see their own
  const admin = await isOrgAdminOrOwner(userId, orgId);

  const keys = await sql<{
    id: string; name: string; key_prefix: string;
    created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
    FROM common.api_keys
    WHERE org_id = ${orgId} AND revoked_at IS NULL AND (${admin} OR user_id = ${userId})
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
  // Any member may create keys: a key acts as its creator in this org (their groups
  // and rules; key:<id> rules can narrow it further), so it grants nothing extra.
  if (!(await isOrgMember(userId, orgId))) return Response.json({ error: "Forbidden" }, { status: 403 });

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
  if (!(await isOrgMember(userId, orgId))) return Response.json({ error: "Forbidden" }, { status: 403 });
  // Admins may revoke any key in the org; members only their own
  const admin = await isOrgAdminOrOwner(userId, orgId);

  const rows = await sql<{ id: string }[]>`
    UPDATE common.api_keys
    SET revoked_at = NOW()
    WHERE id = ${keyId} AND org_id = ${orgId} AND revoked_at IS NULL AND (${admin} OR user_id = ${userId})
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
  // Same principals the access check uses (own + groups, or a narrowed key), plus public rules
  const principals = isOwnOrg && !(principal.startsWith("key:") && await keyHasOwnRules(orgId, principal))
    ? [principal]
    : await effectivePrincipals(orgId, user.userId, principal);
  const permRows = await sql<{
    id: string; principal: string; resource: string; access: string;
    label_filter: string | null; filter_lang: string | null; filter_expr: string | null;
  }[]>`
    SELECT id, principal, resource, access, label_filter, filter_lang, filter_expr
    FROM common.permissions
    WHERE org_id = ${orgId} AND principal = ANY(${[...principals, "*"]})
    ORDER BY created_at DESC
  `;
  const groups = await sql<{ id: string; name: string }[]>`
    SELECT g.id, g.name FROM common.groups g JOIN common.group_members gm ON gm.group_id = g.id
    WHERE g.org_id = ${orgId} AND gm.user_id = ${user.userId} ORDER BY g.name
  `;

  return Response.json({
    principal,
    authMethod: user.keyId ? "api_key" : "session",
    user: { id: user.userId, name: user.name, email: user.email },
    org: { id: orgId, name: orgName, slug: orgSlug, role },
    groups,
    impersonating: impersonationInfo(user),
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

async function handleGetOrg(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const current = await resolveUserOrgId(userId, sessionId, keyOrgId);

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
  // The session may still point at an org this person has been removed from
  if (!(await isOrgMember(userId, orgId))) return Response.json({ error: "Forbidden" }, { status: 403 });
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

async function handleSetOrgSlug(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const currentOrgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
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
// Event streams send a ping every 25 s; lift Bun's 10 s idle timeout for them.
function keepOpen(req: Request): void {
  try { server.timeout(req, 0); } catch {}
}

/** GET /api/v1/orgs/{slug}/_events — public changes only (rules for principal '*'). */
async function handlePublicEvents(slug: string, req: Request, url: URL): Promise<Response> {
  const orgId = await resolveSlugToOrgId(slug);
  if (!orgId) return Response.json({ error: "Not found" }, { status: 404 });
  keepOpen(req);
  return openStream(req, url, orgId, async (resource): Promise<Access> => checkAccess(orgId, "", "*", resource, "read"),
    { "Access-Control-Allow-Origin": "*" });
}

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
  publicView: boolean = !authenticated,
  ruleAccess?: RefAccess, // a member's own rules; null/undefined + !publicView = the owner (everything)
): Promise<string> {
  const schema = sanitizeSchemaName(orgId);
  const accessFor: RefAccess | null = ruleAccess ?? (publicView ? r => checkAccess(orgId, "", "*", r, "read") : null);

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
    // Public viewers and members only see collections their rules actually allow
    // (a broad '*' rule can be narrowed by a 'none' rule on one collection).
    const publicAr = accessFor ? await accessFor(`collection:${col}`) : null;
    if (publicAr && !publicAr.allowed) continue;

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

    // Sample documents. Public visitors only see what a public read would return:
    // the rule's labelled version, with its data filter applied.
    const sampleLabel = publicAr?.labelFilter ?? null;
    const sampleRows = sampleLabel
      ? await sql<{ data: unknown; id: string; current_version: number; labels: string[] }[]>`
          SELECT v.data, d.id, lf.version AS current_version,
                 ARRAY(SELECT label FROM ${sql.unsafe(schema)}.labels WHERE document_id = d.id ORDER BY label) AS labels
          FROM ${sql.unsafe(schema)}.documents d
          JOIN ${sql.unsafe(schema)}.labels lf ON lf.document_id = d.id AND lf.label = ${sampleLabel}
          JOIN ${sql.unsafe(schema)}.versions v ON v.document_id = d.id AND v.version = lf.version
          WHERE d.collection = ${col} AND d.deleted_at IS NULL
          ORDER BY d.updated_at DESC NULLS LAST
          LIMIT 3
        `
      : await sql<{ data: unknown; id: string; current_version: number; labels: string[] }[]>`
          SELECT v.data, d.id, d.current_version,
                 ARRAY(SELECT label FROM ${sql.unsafe(schema)}.labels WHERE document_id = d.id ORDER BY label) AS labels
          FROM ${sql.unsafe(schema)}.documents d
          JOIN ${sql.unsafe(schema)}.versions v ON v.document_id = d.id AND v.version = d.current_version
          WHERE d.collection = ${col} AND d.deleted_at IS NULL
          ORDER BY d.updated_at DESC NULLS LAST
          LIMIT 3
        `;
    const samples = await Promise.all(sampleRows.map(async r => ({
      id: r.id,
      version: r.current_version,
      labels: r.labels,
      data: publicAr?.filterExpr && publicAr.filterLang
        ? await applyDataFilter(r.data, publicAr.filterLang, publicAr.filterExpr)
        : r.data,
    })));

    collectionData.push({ name: col, count, schema: colSchema, labels, samples });
  }

  const totalDocs = collectionData.reduce((s, c) => s + c.count, 0);
  const date = new Date().toISOString().split("T")[0];

  const lines: string[] = [
    `# ${orgName} — Wren data context`,
    ``,
    `> Versioned JSON document store. ${collectionData.length} collections, ${totalDocs} total documents.`,
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
      // Publicly, a tree whose rule shows one label only lists the pages released
      // under it: unreleased paths would give away draft URLs.
      const treeAr = accessFor ? await accessFor(`tree:${treeName}`) : null;
      if (treeAr && (!treeAr.allowed || treeAr.filterExpr)) continue;
      const visibleLabel = treeAr?.labelFilter ?? null;
      const pathRows = await sql<{ path: string; document_id: string; collection: string }[]>`
        SELECT p.path, p.document_id, d.collection
        FROM ${sql.unsafe(schema)}.paths p
        JOIN ${sql.unsafe(schema)}.documents d ON d.id = p.document_id AND d.deleted_at IS NULL
        WHERE p.tree = ${treeName}
          AND (${visibleLabel}::text IS NULL OR EXISTS (
            SELECT 1 FROM ${sql.unsafe(schema)}.labels l WHERE l.document_id = d.id AND l.label = ${visibleLabel}))
        ORDER BY p.path
        LIMIT 20
      `;

      const totalPaths = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM ${sql.unsafe(schema)}.paths p
        JOIN ${sql.unsafe(schema)}.documents d ON d.id = p.document_id AND d.deleted_at IS NULL
        WHERE p.tree = ${treeName}
          AND (${visibleLabel}::text IS NULL OR EXISTS (
            SELECT 1 FROM ${sql.unsafe(schema)}.labels l WHERE l.document_id = d.id AND l.label = ${visibleLabel}))
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
  lines.push(`Org slug: ${slug}`);
  lines.push("");
  lines.push("Public (no auth, read-only, only what principal='*' rules allow; auth headers are ignored here):");
  lines.push(`- Site / browser URLs:  ${base}/orgs/${slug}/tree/{tree}/{path}`);
  lines.push(`- Data (GET, POST _query): ${base}/api/v1/orgs/${slug}/{collection}[/{id}[/raw]]`);
  lines.push("Private (Authorization: Bearer wren_… or session cookie; org comes from the key, never from the URL):");
  lines.push(`- ${base}/api/v1/{collection}[/{id}], ${base}/api/v1/tree/{tree}/{path}, ${base}/api/v1/me`);
  lines.push("");
  if (!authenticated) {
    lines.push(`Full authenticated context: ${base}/api/v1/orgs/${slug}/llms.txt`);
  } else {
    lines.push(`API key creation: POST ${base}/api/v1/keys`);
  }

  return lines.join("\n");
}

async function handleOrgLlmsTxt(slug: string | undefined, url: URL, user: SessionUser | null): Promise<Response> {
  if (!slug) return new Response("Slug required", { status: 400 });

  const orgId = await resolveSlugToOrgId(slug);
  if (!orgId) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const base = publicBase(url);
  const authenticated = user !== null;

  // Determine org name
  const orgUserRows = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM "user" WHERE id = ${orgId}
  `;
  const orgName = orgUserRows[0]?.name ?? slug;
  const orgEmail = orgUserRows[0]?.email ?? "";

  let accessibleCollections: string[];
  let accessibleTrees: string[];
  // True when the caller only gets what principal='*' rules allow (anonymous or non-member).
  let publicView = !authenticated;

  // A key only acts in its own org; elsewhere its holder gets the public view
  const foreignKey = authenticated && !!user!.keyId && user!.keyOrgId !== orgId;
  let memberAccess: RefAccess | undefined;
  if (authenticated && !foreignKey && user!.userId === orgId && !user!.keyId) {
    // The owner, signed in: show all collections
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
    // Authenticated as someone else (or the owner through a key): membership + their rules
    const isMember = !foreignKey && (user!.userId === orgId || (await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${user!.userId}
    `).length > 0);

    if (isMember) {
      const principal = principalFor(user!);
      memberAccess = r => checkAccess(orgId, user!.userId, principal, r, "read");
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
      publicView = true;
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

  const body = await generateLlmsTxt(orgId, orgName, slug, base, accessibleCollections, accessibleTrees, authenticated, publicView, memberAccess);
  return new Response(body, { headers: {
    "Content-Type": "text/plain; charset=utf-8",
    // Owner/member views include private data — keep them out of shared caches.
    ...(publicView ? {} : { "Cache-Control": "private, no-store" }),
  } });
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

async function handleListInvites(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
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

async function handleCreateInvite(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as { email?: string; role?: string; groupIds?: unknown };
  const email = body.email?.trim().toLowerCase();
  const role = body.role ?? "member";
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "email is not a valid address" }, { status: 400 });
  // role = what they may manage (admin: invites, keys, rules, groups); groups = which data
  if (!["member", "admin"].includes(role)) return Response.json({ error: "role must be member or admin" }, { status: 400 });
  await ensureDefaultGroups(orgId);
  const groupIds = await validGroupIds(orgId, body.groupIds);
  if (groupIds === null) return Response.json({ error: "groupIds must be ids of this org's groups" }, { status: 400 });

  const rawToken = generateInviteToken();
  const tokenHash = await sha256hex(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  const [invite] = await sql<{ id: string; created_at: Date; expires_at: Date }[]>`
    INSERT INTO common.invites (org_id, email, token_hash, token_prefix, role, invited_by, group_ids)
    VALUES (${orgId}, ${email}, ${tokenHash}, ${tokenPrefix}, ${role}, ${userId}, ${groupIds})
    RETURNING id, created_at, expires_at
  `;

  // Email the invite. Same base URL as Better Auth's confirmation/reset links.
  const base = (process.env.BETTER_AUTH_URL?.replace(/\r/g, "").trim() || new URL(req.url).origin).replace(/\/$/, "");
  const acceptUrl = `${base}/admin/#/accept/${encodeURIComponent(rawToken)}`;
  const people = await sql<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email FROM "user" WHERE id = ANY(${[userId, orgId]})
  `;
  const inviter = people.find(p => p.id === userId);
  const owner = people.find(p => p.id === orgId);
  const emailSent = await sendMail(inviteMail(email, inviter?.name || inviter?.email || "Someone",
    owner?.name || owner?.email || "a WREN org", role, acceptUrl));

  return Response.json({
    id: invite.id,
    email,
    role,
    groupIds,
    // false when no mail transport is configured (MAIL_TRANSPORT=log): share acceptUrl yourself
    emailSent,
    acceptUrl,
    token: rawToken, // returned once only — never stored in plaintext
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    acceptedAt: null,
    revokedAt: null,
  }, { status: 201 });
}

async function handleListReceivedInvites(user: SessionUser): Promise<Response> {
  const [u] = await sql<{ email: string; email_verified: boolean }[]>`SELECT email, email_verified FROM "user" WHERE id = ${user.userId}`;
  if (!u) return Response.json({ invites: [] });
  // Only a confirmed address may see (and accept) invites sent to it.
  if (!u.email_verified) return Response.json({ invites: [], emailVerified: false });

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
  const [u] = await sql<{ email: string; email_verified: boolean }[]>`SELECT email, email_verified FROM "user" WHERE id = ${user.userId}`;
  if (!u) return Response.json({ error: "User not found" }, { status: 404 });
  // Without the link, the only proof of owning the invited address is a confirmed
  // email; otherwise anyone could register that address and accept.
  if (!u.email_verified) {
    return Response.json({
      error: "Confirm your email address first, or open the invite link you received.",
      code: "EMAIL_NOT_VERIFIED",
    }, { status: 403 });
  }

  const [invite] = await sql<{
    id: string; org_id: string; email: string; role: string; group_ids: string[];
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, org_id, email, role, group_ids, expires_at, accepted_at, revoked_at
    FROM common.invites WHERE id = ${inviteId}
  `;
  if (!invite)            return Response.json({ error: "Invite not found" }, { status: 404 });
  if (invite.email.trim().toLowerCase() !== u.email.trim().toLowerCase())
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
  await joinInviteGroups(invite.org_id, user.userId, invite.group_ids);
  await sql`UPDATE common.invites SET accepted_at = NOW() WHERE id = ${invite.id}`;

  return Response.json({ accepted: true, orgId: invite.org_id });
}

async function handleRevokeInvite(inviteId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
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
    id: string; org_id: string; email: string; role: string; group_ids: string[];
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, org_id, email, role, group_ids, expires_at, accepted_at, revoked_at
    FROM common.invites WHERE token_hash = ${tokenHash}
  `;
  if (!invite)             return Response.json({ error: "Invalid invite token" }, { status: 404 });
  if (invite.revoked_at)   return Response.json({ error: "Invite has been revoked" }, { status: 410 });
  if (invite.accepted_at)  return Response.json({ error: "Invite already accepted" }, { status: 409 });
  if (new Date(invite.expires_at) < new Date())
                           return Response.json({ error: "Invite has expired" }, { status: 410 });
  if (invite.org_id === userId)
                           return Response.json({ error: "Cannot accept your own invite" }, { status: 400 });

  // The invite is for one email address: the link proves possession (it was sent
  // there), the account proves who accepts. Anyone else holding the link can't use it.
  const [u] = await sql<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${userId}`;
  if (!u || u.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
    return Response.json({
      error: `This invite is for ${invite.email}. Sign in (or create an account) with that email address to accept it.`,
      code: "INVITE_EMAIL_MISMATCH",
    }, { status: 403 });
  }

  await sql`
    INSERT INTO common.org_members (org_id, user_id, role)
    VALUES (${invite.org_id}, ${userId}, ${invite.role})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${invite.role}
  `;
  await joinInviteGroups(invite.org_id, userId, invite.group_ids);
  await sql`UPDATE common.invites SET accepted_at = NOW() WHERE id = ${invite.id}`;

  return Response.json({ accepted: true, orgId: invite.org_id });
}

// -------------------------------------------------------
// MCP with browser sign-in (OAuth)
// -------------------------------------------------------
// Flow: client POSTs /mcp/login → 401 with resource metadata → discovers the
// authorization server → registers → /api/auth/mcp/authorize (forced to
// prompt=consent) → /login if needed → /mcp/consent: user approves and picks an org
// → token. Every /mcp/login call then acts as that user in that org.

const internalDispatch = (r: Request) => { internalRequests.add(r); return handleRequest(r, new URL(r.url)); };

function mcpProtectedResource(url: URL) {
  const base = publicBase(url);
  const issuer = (process.env.BETTER_AUTH_URL?.replace(/\r/g, "").trim() || base).replace(/\/$/, "");
  return {
    resource: `${base}/mcp/login`,
    resource_name: "WREN",
    authorization_servers: [issuer],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
  };
}

async function handleMcpLogin(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST") return handleMcp(req, url, internalDispatch, WREN_VERSION);   // → 405
  const challenge = (message: string, invalid = false) => new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }),
    { status: 401, headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${publicBase(url)}/.well-known/oauth-protected-resource/mcp/login"${invalid ? ', error="invalid_token"' : ""}`,
    } },
  );
  const authz = req.headers.get("authorization") ?? "";
  if (!authz.startsWith("Bearer ")) return challenge("Sign in required");
  if (authz.startsWith("Bearer wren_")) return challenge("API keys use /mcp; /mcp/login is for browser sign-in", true);

  const token = await (auth.api as any).getMcpSession({ headers: req.headers }).catch(() => null) as { userId?: string; clientId?: string } | null;
  if (!token?.userId || !token.clientId) return challenge("Invalid or expired sign-in", true);
  const [grant] = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.mcp_grants WHERE user_id = ${token.userId} AND client_id = ${token.clientId}
  `;
  if (!grant) return challenge("No org was chosen for this connection; sign in again", true);
  if (!(await isOrgMember(token.userId, grant.org_id))) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32003, message: "You are no longer a member of the org this connection was approved for" } }, { status: 403 });
  }
  const [u] = await sql<{ name: string; email: string }[]>`SELECT name, email FROM "user" WHERE id = ${token.userId}`;
  const ctx = requestContext.getStore();
  if (ctx) ctx.mcpUser = { userId: token.userId, name: u?.name ?? "", email: u?.email ?? "", sessionId: null, keyOrgId: grant.org_id };
  return handleMcp(req, url, internalDispatch, WREN_VERSION, undefined, {
    presetIdentity: true,
    anonDispatch: r => handleRequest(r, new URL(r.url)),   // public_* tools: never the user's identity
  });
}

// Orgs a signed-in user can approve an MCP connection for: their own + memberships.
async function orgChoices(userId: string) {
  const own = await sql<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${userId}`;
  const ownSlug = own[0] ? await getOrCreateSlug(userId, own[0].email) : null;
  const memberships = await sql<{ org_id: string; role: string; name: string; slug: string | null }[]>`
    SELECT m.org_id, m.role, u.name, s.slug
    FROM common.org_members m JOIN "user" u ON u.id = m.org_id LEFT JOIN common.org_slugs s ON s.org_id = m.org_id
    WHERE m.user_id = ${userId} ORDER BY u.name
  `;
  return [
    { id: userId, name: "My workspace", slug: ownSlug, role: "owner" },
    ...memberships.map(m => ({ id: m.org_id, name: m.name, slug: m.slug, role: m.role })),
  ];
}

async function handleMcpConsentInfo(req: Request, url: URL): Promise<Response> {
  const user = await requireSession(req);
  if (!user || user.keyId) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (user.impersonator) return Response.json({ error: "Not available while viewing as someone else" }, { status: 403 });
  const clientId = url.searchParams.get("client_id") ?? "";
  const [app] = await sql<{ name: string; redirect_urls: string; icon: string | null }[]>`
    SELECT name, redirect_urls, icon FROM public.oauth_application WHERE client_id = ${clientId}
  `;
  if (!app) return Response.json({ error: "Unknown application" }, { status: 404 });
  const redirectHosts = [...new Set(app.redirect_urls.split(",").map(u => { try { return new URL(u.trim()).host; } catch { return u.trim(); } }))];
  return Response.json({
    client: { name: app.name, icon: app.icon, redirectHosts },
    user: { name: user.name, email: user.email },
    orgs: await orgChoices(user.userId),
  });
}

async function handleMcpConsentApprove(req: Request): Promise<Response> {
  const user = await requireSession(req);
  if (!user || user.keyId) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (user.impersonator) return Response.json({ error: "Not available while viewing as someone else" }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { consent_code?: string; client_id?: string; org_id?: string; accept?: boolean };
  if (!body.consent_code || !body.client_id) return Response.json({ error: "consent_code and client_id are required" }, { status: 400 });

  // The consent code must be this user's pending authorization for this client
  const [pending] = await sql<{ value: string }[]>`SELECT value FROM public.verification WHERE identifier = ${body.consent_code} AND expires_at > NOW()`;
  let p: { clientId?: string; userId?: string } = {};
  try { p = JSON.parse(pending?.value ?? "{}"); } catch {}
  if (p.clientId !== body.client_id || p.userId !== user.userId) {
    return Response.json({ error: "This authorization request has expired or isn't yours; start again from your app" }, { status: 400 });
  }

  if (body.accept) {
    if (!body.org_id || !(await isOrgMember(user.userId, body.org_id))) {
      return Response.json({ error: "Choose one of your orgs" }, { status: 400 });
    }
    await sql`
      INSERT INTO common.mcp_grants (user_id, client_id, org_id) VALUES (${user.userId}, ${body.client_id}, ${body.org_id})
      ON CONFLICT (user_id, client_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = NOW()
    `;
  }
  const result = await (auth.api as any).oAuthConsent({ body: { accept: !!body.accept, consent_code: body.consent_code }, headers: req.headers })
    .catch((e: Error) => ({ error: e.message }));
  if (!result?.redirectURI) return Response.json({ error: result?.error ?? "Could not complete authorization" }, { status: 400 });
  return Response.json({ redirectURI: result.redirectURI });
}

// Apps the user signed in to WREN via MCP (OAuth), across all their orgs.
async function handleListConnectedApps(user: SessionUser): Promise<Response> {
  const rows = await sql<{
    client_id: string; name: string; redirect_urls: string; icon: string | null;
    first_at: Date; last_at: Date; refresh_expires: Date | null;
    org_id: string | null; org_name: string | null; org_slug: string | null;
  }[]>`
    SELECT t.client_id, a.name, a.redirect_urls, a.icon,
           MIN(t.created_at) AS first_at, MAX(t.created_at) AS last_at, MAX(t.refresh_token_expires_at) AS refresh_expires,
           g.org_id, ou.name AS org_name, s.slug AS org_slug
    FROM public.oauth_access_token t
    JOIN public.oauth_application a ON a.client_id = t.client_id
    LEFT JOIN common.mcp_grants g ON g.user_id = t.user_id AND g.client_id = t.client_id
    LEFT JOIN "user" ou ON ou.id = g.org_id
    LEFT JOIN common.org_slugs s ON s.org_id = g.org_id
    WHERE t.user_id = ${user.userId}
    GROUP BY t.client_id, a.name, a.redirect_urls, a.icon, g.org_id, ou.name, s.slug
    ORDER BY MAX(t.created_at) DESC
  `;
  return Response.json({
    apps: rows.map(r => ({
      clientId: r.client_id,
      name: r.name,
      icon: r.icon,
      redirectHosts: [...new Set(r.redirect_urls.split(",").map(u => { try { return new URL(u.trim()).host; } catch { return u.trim(); } }))],
      org: r.org_id ? { id: r.org_id, name: r.org_id === user.userId ? "My workspace" : r.org_name, slug: r.org_slug } : null,
      connectedAt: r.first_at,
      lastRenewedAt: r.last_at,
      expiresAt: r.refresh_expires,
    })),
  });
}

// Revoke: delete the app's tokens, consent and org choice for this user. The app's
// next call fails (tokens are looked up on every request) and it must ask again.
async function handleRevokeConnectedApp(clientId: string, user: SessionUser): Promise<Response> {
  const tokens = await sql`DELETE FROM public.oauth_access_token WHERE user_id = ${user.userId} AND client_id = ${clientId} RETURNING id`;
  await sql`DELETE FROM public.oauth_consent WHERE user_id = ${user.userId} AND client_id = ${clientId}`;
  const grants = await sql`DELETE FROM common.mcp_grants WHERE user_id = ${user.userId} AND client_id = ${clientId} RETURNING client_id`;
  if (!tokens.length && !grants.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ clientId, revoked: true, tokensRevoked: tokens.length });
}

// -------------------------------------------------------
// Group handlers
// -------------------------------------------------------
// Groups hold people; permission rules name a group as principal 'group:<id>'.
// Every org starts with two: Editors (write on everything) and Viewers (read).

async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  if (userId === orgId) return true;
  return (await sql`SELECT 1 FROM common.org_members WHERE org_id = ${orgId} AND user_id = ${userId}`).length > 0;
}

async function ensureDefaultGroups(orgId: string): Promise<void> {
  const existing = await sql`SELECT 1 FROM common.groups WHERE org_id = ${orgId} LIMIT 1`;
  if (existing.length) return;
  for (const [name, description, access] of [
    ["Editors", "Read and write all collections and trees", "write"],
    ["Viewers", "Read all collections and trees", "read"],
  ] as const) {
    const [g] = await sql<{ id: string }[]>`
      INSERT INTO common.groups (org_id, name, description) VALUES (${orgId}, ${name}, ${description})
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `;
    await sql`
      INSERT INTO common.permissions (org_id, principal, resource, access)
      VALUES (${orgId}, ${"group:" + g.id}, '*', ${access})
      ON CONFLICT (org_id, principal, resource) DO NOTHING
    `;
  }
}

async function handleListGroups(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;
  await ensureDefaultGroups(orgId);
  const groups = await sql<{ id: string; name: string; description: string | null; created_at: Date }[]>`
    SELECT id, name, description, created_at FROM common.groups WHERE org_id = ${orgId} ORDER BY name
  `;
  const members = await sql<{ group_id: string; user_id: string; name: string; email: string }[]>`
    SELECT gm.group_id, gm.user_id, u.name, u.email
    FROM common.group_members gm JOIN common.groups g ON g.id = gm.group_id JOIN "user" u ON u.id = gm.user_id
    WHERE g.org_id = ${orgId} ORDER BY u.name
  `;
  const rules = await sql<{ principal: string; id: string; resource: string; access: string; label_filter: string | null }[]>`
    SELECT principal, id, resource, access, label_filter FROM common.permissions
    WHERE org_id = ${orgId} AND principal LIKE 'group:%' ORDER BY resource
  `;
  return Response.json({
    groups: groups.map(g => ({
      id: g.id, name: g.name, description: g.description, createdAt: g.created_at,
      members: members.filter(m => m.group_id === g.id).map(m => ({ userId: m.user_id, name: m.name, email: m.email })),
      rules: rules.filter(r => r.principal === `group:${g.id}`)
        .map(r => ({ id: r.id, resource: r.resource, access: r.access, labelFilter: r.label_filter })),
    })),
  });
}

async function handleCreateGroup(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;
  const body = await req.json().catch(() => ({})) as { name?: string; description?: string; access?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (body.access && !["none", "read", "write", "admin"].includes(body.access))
    return Response.json({ error: "access must be none|read|write|admin" }, { status: 400 });
  const rows = await sql<{ id: string }[]>`
    INSERT INTO common.groups (org_id, name, description) VALUES (${orgId}, ${name}, ${body.description ?? null})
    ON CONFLICT (org_id, name) DO NOTHING RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "A group with that name already exists" }, { status: 409 });
  // Convenience: an org-wide rule in one step; finer rules via POST /api/v1/permissions
  if (body.access) {
    await sql`
      INSERT INTO common.permissions (org_id, principal, resource, access)
      VALUES (${orgId}, ${"group:" + rows[0].id}, '*', ${body.access})
    `;
  }
  return Response.json({ id: rows[0].id, name, description: body.description ?? null }, { status: 201 });
}

async function handleUpdateGroup(groupId: string, req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;
  const body = await req.json().catch(() => ({})) as { name?: string; description?: string };
  const rows = await sql<{ id: string }[]>`
    UPDATE common.groups SET name = COALESCE(${body.name?.trim() || null}, name),
      description = COALESCE(${body.description ?? null}, description)
    WHERE id = ${groupId} AND org_id = ${orgId} RETURNING id
  `.catch(() => null);
  if (rows === null) return Response.json({ error: "A group with that name already exists" }, { status: 409 });
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: groupId, updated: true });
}

async function handleDeleteGroup(groupId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;
  const rows = await sql<{ id: string }[]>`DELETE FROM common.groups WHERE id = ${groupId} AND org_id = ${orgId} RETURNING id`;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  await sql`DELETE FROM common.permissions WHERE org_id = ${orgId} AND principal = ${"group:" + groupId}`;
  return Response.json({ id: groupId, deleted: true });
}

async function handleGroupMember(groupId: string, memberId: string, add: boolean, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;
  const g = await sql`SELECT 1 FROM common.groups WHERE id = ${groupId} AND org_id = ${orgId}`;
  if (!g.length) return Response.json({ error: "Not found" }, { status: 404 });
  if (add) {
    if (!(await isOrgMember(memberId, orgId)) || memberId === orgId)
      return Response.json({ error: "Only members of this org can be added to its groups" }, { status: 400 });
    await sql`INSERT INTO common.group_members (group_id, user_id) VALUES (${groupId}, ${memberId}) ON CONFLICT DO NOTHING`;
  } else {
    await sql`DELETE FROM common.group_members WHERE group_id = ${groupId} AND user_id = ${memberId}`;
  }
  return Response.json({ groupId, userId: memberId, member: add });
}

// Groups named by an invite must belong to the inviting org.
async function validGroupIds(orgId: string, ids: unknown): Promise<string[] | null> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || !ids.every(x => typeof x === "string")) return null;
  if (!ids.length) return [];
  const rows = await sql<{ id: string }[]>`SELECT id FROM common.groups WHERE org_id = ${orgId} AND id = ANY(${ids})`;
  return rows.length === new Set(ids).size ? rows.map(r => r.id) : null;
}

async function joinInviteGroups(orgId: string, userId: string, groupIds: string[]): Promise<void> {
  if (!groupIds?.length) return;
  await sql`
    INSERT INTO common.group_members (group_id, user_id)
    SELECT id, ${userId} FROM common.groups WHERE org_id = ${orgId} AND id = ANY(${groupIds})
    ON CONFLICT DO NOTHING
  `;
}

// -------------------------------------------------------
// Impersonation (org admins "view as" a member of their org)
// -------------------------------------------------------

const IMPERSONATION_MINUTES = 60;

function impersonationInfo(user: SessionUser) {
  return user.impersonator
    ? { as: { userId: user.userId, name: user.name, email: user.email }, by: { userId: user.impersonator.userId, name: user.impersonator.name, email: user.impersonator.email }, orgId: user.keyOrgId, expiresAt: user.impersonator.expiresAt }
    : null;
}

async function handleStartImpersonation(targetId: string, user: SessionUser): Promise<Response> {
  // Browser sessions only: an API key can't impersonate
  if (!user.sessionId || user.keyId) return Response.json({ error: "Impersonation needs a signed-in session, not an API key" }, { status: 403 });
  const orgId = await resolveUserOrgId(user.userId, user.sessionId, user.keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(user.userId, orgId);
  if (guard) return guard;
  if (targetId === user.userId) return Response.json({ error: "You can't impersonate yourself" }, { status: 400 });
  if (targetId === orgId) return Response.json({ error: "The org owner can't be impersonated" }, { status: 403 });
  if (!(await isOrgMember(targetId, orgId))) return Response.json({ error: "Not a member of this org" }, { status: 404 });

  await sql`UPDATE common.impersonations SET ended_at = NOW() WHERE session_id = ${user.sessionId} AND ended_at IS NULL`;
  const [row] = await sql<{ id: string; expires_at: Date }[]>`
    INSERT INTO common.impersonations (session_id, org_id, admin_user_id, target_user_id, expires_at)
    VALUES (${user.sessionId}, ${orgId}, ${user.userId}, ${targetId}, NOW() + ${IMPERSONATION_MINUTES + " minutes"}::interval)
    RETURNING id, expires_at
  `;
  const [t] = await sql<{ name: string; email: string }[]>`SELECT name, email FROM "user" WHERE id = ${targetId}`;
  logAccess(orgId, `member:${user.userId}`, `impersonation-start:${targetId}`, "POST", `/api/v1/members/${targetId}/impersonate`, 200);
  return Response.json({ impersonationId: row.id, as: { userId: targetId, name: t?.name, email: t?.email }, orgId, expiresAt: row.expires_at });
}

async function handleEndImpersonation(user: SessionUser): Promise<Response> {
  if (!user.impersonator || !user.sessionId) return Response.json({ ended: false, reason: "not impersonating" });
  await sql`UPDATE common.impersonations SET ended_at = NOW() WHERE session_id = ${user.sessionId} AND ended_at IS NULL`;
  logAccess(user.keyOrgId ?? "", `member:${user.impersonator.userId}`, `impersonation-end:${user.userId}`, "DELETE", "/api/v1/impersonation", 200);
  return Response.json({ ended: true });
}

// -------------------------------------------------------
// Member handlers
// -------------------------------------------------------

async function handleListMembers(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const members = await sql<{ user_id: string; role: string; joined_at: Date; name: string; email: string }[]>`
    SELECT m.user_id, m.role, m.joined_at, u.name, u.email
    FROM common.org_members m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.org_id = ${orgId}
    ORDER BY m.joined_at ASC
  `;
  const memberGroups = await sql<{ user_id: string; id: string; name: string }[]>`
    SELECT gm.user_id, g.id, g.name FROM common.group_members gm JOIN common.groups g ON g.id = gm.group_id
    WHERE g.org_id = ${orgId} ORDER BY g.name
  `;
  return Response.json({
    members: members.map(m => ({
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      name: m.name,
      email: m.email,
      groups: memberGroups.filter(g => g.user_id === m.user_id).map(g => ({ id: g.id, name: g.name })),
    })),
  });
}

async function handleRemoveMember(memberId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
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
  // Leaving the org also leaves its groups and ends any impersonation of them
  await sql`
    DELETE FROM common.group_members gm USING common.groups g
    WHERE gm.group_id = g.id AND g.org_id = ${orgId} AND gm.user_id = ${memberId}
  `;
  await sql`UPDATE common.impersonations SET ended_at = NOW() WHERE org_id = ${orgId} AND target_user_id = ${memberId} AND ended_at IS NULL`;
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

async function handleListPermissions(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{
    id: string; principal: string; resource: string; access: string;
    label_filter: string | null; filter_lang: string | null; filter_expr: string | null;
    audit_reads: boolean; audit_writes: boolean; alias: string | null; created_at: Date;
  }[]>`
    SELECT id, principal, resource, access, label_filter, filter_lang, filter_expr,
           audit_reads, audit_writes, alias, created_at
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
      alias: r.alias,
      createdAt: r.created_at,
    })),
  });
}

async function handleCreatePermission(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as {
    principal?: string; resource?: string; access?: string;
    labelFilter?: string; filterLang?: string; filterExpr?: string;
    auditReads?: boolean; auditWrites?: boolean; alias?: string;
  };

  const { principal, resource, access = "read", labelFilter = null, filterLang = null, filterExpr = null,
          auditReads = false, auditWrites = false } = body;
  const alias = typeof body.alias === "string" && body.alias.trim() ? body.alias.trim() : null;

  if (!principal) return Response.json({ error: "principal is required" }, { status: 400 });
  if (!resource)  return Response.json({ error: "resource is required" }, { status: 400 });
  if (!/^(\*|member:.+|key:.+|group:.+)$/.test(principal))
    return Response.json({ error: "principal must be *, member:<userId>, key:<keyId> or group:<groupId>" }, { status: 400 });
  if (principal.startsWith("group:")) {
    const g = await sql`SELECT 1 FROM common.groups WHERE id = ${principal.slice(6)} AND org_id = ${orgId}`;
    if (!g.length) return Response.json({ error: "Unknown group for this org" }, { status: 400 });
  }
  if (!["none", "read", "write", "admin"].includes(access))
    return Response.json({ error: "access must be none|read|write|admin" }, { status: 400 });
  if (filterLang && !["jq", "jmespath", "jsonata"].includes(filterLang))
    return Response.json({ error: "filterLang must be jq|jmespath|jsonata" }, { status: 400 });
  if (filterExpr && !filterLang)
    return Response.json({ error: "filterLang is required when filterExpr is set" }, { status: 400 });
  if (filterExpr && filterLang) {
    const exprError = await filterExprError(filterLang, filterExpr);
    if (exprError) return Response.json({ error: exprError }, { status: 400 });
  }

  // Validate alias: no reserved keywords, no _ prefix, alphanumeric + hyphens only
  if (alias) {
    if (!/^[a-z][a-z0-9-]*$/.test(alias))
      return Response.json({ error: "Alias must be lowercase alphanumeric with hyphens, starting with a letter" }, { status: 400 });
    const reserved = new Set(["tree", "keys", "org", "me", "webhooks", "permissions", "members", "invites", "collections", "projects", "health", "docs", "admin"]);
    if (reserved.has(alias) || alias.startsWith("_"))
      return Response.json({ error: `Alias "${alias}" is reserved` }, { status: 400 });
  }

  const [row] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO common.permissions
      (org_id, principal, resource, access, label_filter, filter_lang, filter_expr, audit_reads, audit_writes, alias)
    VALUES
      (${orgId}, ${principal}, ${resource}, ${access}, ${labelFilter}, ${filterLang}, ${filterExpr},
       ${auditReads}, ${auditWrites}, ${alias})
    ON CONFLICT (org_id, principal, resource) DO UPDATE
      SET access       = EXCLUDED.access,
          label_filter = EXCLUDED.label_filter,
          filter_lang  = EXCLUDED.filter_lang,
          filter_expr  = EXCLUDED.filter_expr,
          audit_reads  = EXCLUDED.audit_reads,
          audit_writes = EXCLUDED.audit_writes,
          alias        = EXCLUDED.alias
    RETURNING id, created_at
  `.catch(e => {
    if (e?.code === "23505" && String(e.constraint_name ?? "").includes("alias")) {
      throw new HttpError(409, `Alias "${alias}" is already used by another rule`);
    }
    throw e;
  });

  return Response.json({
    id: row.id, principal, resource, access, labelFilter, filterLang, filterExpr,
    auditReads, auditWrites, alias, createdAt: row.created_at,
  }, { status: 201 });
}

async function handleUpdatePermission(permId: string, req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
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
  if (body.filterExpr || body.filterLang) {
    const [cur] = await sql<{ filter_lang: string | null; filter_expr: string | null }[]>`
      SELECT filter_lang, filter_expr FROM common.permissions WHERE id = ${permId} AND org_id = ${orgId}
    `;
    const lang = "filterLang" in body ? body.filterLang : cur?.filter_lang;
    const expr = "filterExpr" in body ? body.filterExpr : cur?.filter_expr;
    if (expr && !lang) return Response.json({ error: "filterLang is required when filterExpr is set" }, { status: 400 });
    const exprError = expr && lang ? await filterExprError(lang, expr) : null;
    if (exprError) return Response.json({ error: exprError }, { status: 400 });
  }

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

async function handleDeletePermission(permId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{ id: string }[]>`
    DELETE FROM common.permissions WHERE id = ${permId} AND org_id = ${orgId} RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: permId, deleted: true });
}

// ── Retention policies ───────────────────────────────────────────────────────
// "*" is the org default; any other name is a collection's own policy.

async function retentionOrg(user: SessionUser): Promise<{ orgId: string; schemaName: string } | Response> {
  const orgId = await resolveUserOrgId(user.userId, user.sessionId, user.keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(user.userId, orgId);
  if (guard) return guard;
  return { orgId, schemaName: await ensureTenant(orgId) };
}

const policyJson = (r: Parameters<typeof retention.fromRow>[0]) =>
  ({ collection: r.collection, ...retention.fromRow(r), updatedAt: r.updated_at, updatedBy: r.updated_by });

async function handleGetRetention(user: SessionUser): Promise<Response> {
  const org = await retentionOrg(user);
  if (org instanceof Response) return org;
  const rows = await retention.orgPolicies(sql, org.orgId);
  const runs = await sql<{ collection: string; versions_removed: number; bytes_freed: string; triggered_by: string | null; ran_at: Date }[]>`
    SELECT collection, versions_removed, bytes_freed::text, triggered_by, ran_at FROM common.retention_runs
    WHERE org_id = ${org.orgId} ORDER BY ran_at DESC LIMIT 20
  `;
  return Response.json({
    default: rows.filter(r => r.collection === "*").map(policyJson)[0] ?? null,
    collections: rows.filter(r => r.collection !== "*").map(policyJson),
    runs: runs.map(r => ({ collection: r.collection, versionsRemoved: r.versions_removed, bytesFreed: Number(r.bytes_freed), triggeredBy: r.triggered_by, ranAt: r.ran_at })),
  });
}

function retentionTarget(name: string): string | Response {
  const target = decodeURIComponent(name);
  if (target !== "*" && (target.startsWith("_") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target))) {
    return Response.json({ error: "Use * for the org default, or a collection name" }, { status: 400 });
  }
  return target;
}

async function handleSetRetention(name: string, req: Request, user: SessionUser): Promise<Response> {
  const org = await retentionOrg(user);
  if (org instanceof Response) return org;
  const target = retentionTarget(name);
  if (target instanceof Response) return target;
  const p = retention.parsePolicy(await req.json());
  if (typeof p === "string") return Response.json({ error: p }, { status: 400 });
  const [row] = await sql<Parameters<typeof retention.fromRow>[0][]>`
    INSERT INTO common.retention_policies (org_id, collection, labeled_only, max_versions, max_age_days, after_label, updated_by, updated_at)
    VALUES (${org.orgId}, ${target}, ${p.labeledOnly}, ${p.maxVersions}, ${p.maxAgeDays}, ${p.afterLabel}, ${user.userId}, NOW())
    ON CONFLICT (org_id, collection) DO UPDATE SET
      labeled_only = EXCLUDED.labeled_only, max_versions = EXCLUDED.max_versions, max_age_days = EXCLUDED.max_age_days,
      after_label = EXCLUDED.after_label, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    RETURNING collection, labeled_only, max_versions, max_age_days, after_label, updated_at, updated_by
  `;
  return Response.json(policyJson(row));
}

async function handleDeleteRetention(name: string, user: SessionUser): Promise<Response> {
  const org = await retentionOrg(user);
  if (org instanceof Response) return org;
  const target = retentionTarget(name);
  if (target instanceof Response) return target;
  const rows = await sql`DELETE FROM common.retention_policies WHERE org_id = ${org.orgId} AND collection = ${target} RETURNING 1`;
  if (!rows.length) return Response.json({ error: "No policy for that collection" }, { status: 404 });
  return Response.json({ collection: target, deleted: true });
}

/** What a policy would remove: the saved one, or one in the body (nothing is changed). */
async function handlePreviewRetention(name: string, req: Request, user: SessionUser): Promise<Response> {
  const org = await retentionOrg(user);
  if (org instanceof Response) return org;
  const target = retentionTarget(name);
  if (target instanceof Response) return target;
  const text = await req.text();
  let proposed: retention.Policy | null = null;
  if (text.trim()) {
    const p = retention.parsePolicy(JSON.parse(text));
    if (typeof p === "string") return Response.json({ error: p }, { status: 400 });
    proposed = p;
  }
  const effective = await retention.effectivePolicies(sql, withTenant, org.schemaName, org.orgId);
  let targets: { collection: string; policy: retention.Policy }[];
  if (target === "*") {
    // The default applies to every collection without a policy of its own
    const own = new Set((await retention.orgPolicies(sql, org.orgId)).map(r => r.collection).filter(c => c !== "*"));
    const all = await withTenant(org.schemaName, tx => tx<{ collection: string }[]>`
      SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE '\\_%' ORDER BY collection
    `);
    const saved = effective.find(e => e.source === "default")?.policy ?? null;
    const policy = proposed ?? saved;
    targets = policy ? all.filter(c => !own.has(c.collection)).map(c => ({ collection: c.collection, policy })) : [];
  } else {
    const policy = proposed ?? effective.find(e => e.collection === target)?.policy ?? null;
    targets = policy ? [{ collection: target, policy }] : [];
  }
  const plans: retention.Plan[] = [];
  for (const t of targets) plans.push(await retention.preview(withTenant, org.schemaName, t.collection, t.policy));
  const total = plans.reduce((a, p) => ({ versions: a.versions + p.versions, documents: a.documents + p.documents, bytes: a.bytes + p.bytes }), { versions: 0, documents: 0, bytes: 0 });
  return Response.json({ collections: plans.filter(p => p.versions > 0), total });
}

async function handleApplyRetention(user: SessionUser): Promise<Response> {
  const org = await retentionOrg(user);
  if (org instanceof Response) return org;
  const plans = await retention.applyOrg(sql, withTenant, org.schemaName, org.orgId, user.userId);
  return Response.json({
    collections: plans,
    total: plans.reduce((a, p) => ({ versions: a.versions + p.versions, documents: a.documents + p.documents, bytes: a.bytes + p.bytes }), { versions: 0, documents: 0, bytes: 0 }),
  });
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

// Webhooks only go to public addresses: anyone who owns an org can register one, and
// the server must not become a way to reach its own network (the database, other
// containers, cloud metadata). Checked when a webhook is saved and again before each
// delivery (DNS can change); redirects aren't followed. Self-hosters can allow
// internal receivers by host name: WREN_WEBHOOK_ALLOW_HOSTS=n8n.internal,hooks.lan
const WEBHOOK_ALLOW_HOSTS = new Set((process.env.WREN_WEBHOOK_ALLOW_HOSTS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

/** The eight 16-bit groups of an IPv6 address (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined ? (rest ? rest.split(":") : []) : null;
  const groups = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  if (groups.length !== 8) return null;
  const nums = groups.map(g => parseInt(g, 16));
  return nums.some(n => isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const g = ipv6Groups(ip);
  if (!g) return true; // can't tell: don't send
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => g.slice(0, n).every(x => x === 0);
  if (zeros(8) || (zeros(7) && g[7] === 1)) return true;                  // :: and ::1
  if (zeros(5) && g[5] === 0xffff) return isPrivateIPv4(v4(g[6], g[7]));  // ::ffff:a.b.c.d (mapped)
  if (zeros(6)) return isPrivateIPv4(v4(g[6], g[7]));                     // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIPv4(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(v4(g[1], g[2]));              // 6to4
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00; // ULA, link-local, multicast
}

/** Why a webhook may not be sent to this URL, or null if it may. */
async function webhookTargetError(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return "Invalid URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Webhook URL must use http or https";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (WEBHOOK_ALLOW_HOSTS.has(host)) return null;
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addrs.length) return `Webhook host ${host} does not resolve`;
  if (addrs.some(isPrivateAddress)) return "Webhook URL points at a private or local address";
  return null;
}

// Orgs without an enabled webhook don't queue events. Cleared whenever a webhook is
// created, changed or deleted, so a new webhook gets its first events.
const webhookOrgCache = new Map<string, { at: number; has: boolean }>();
async function orgHasWebhooks(orgId: string): Promise<boolean> {
  const hit = webhookOrgCache.get(orgId);
  if (hit && Date.now() - hit.at < 60_000) return hit.has;
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM common.webhooks WHERE org_id = ${orgId} AND enabled = true`.catch(() => [{ n: 1 }]);
  webhookOrgCache.set(orgId, { at: Date.now(), has: row.n > 0 });
  return row.n > 0;
}

function webhookBatchKey(orgId: string): string {
  return `${orgId}:${Math.floor(Date.now() / WEBHOOK_BATCH_WINDOW_MS)}`;
}

async function emitWebhookEvent(orgId: string, eventType: string, payload: object): Promise<void> {
  const key = webhookBatchKey(orgId);

  // Persist to Postgres for crash recovery
  await sql`
    INSERT INTO common.webhook_events (org_id, event_type, payload, batch_key)
    VALUES (${orgId}, ${eventType}, ${sql.json(payload)}, ${key})
  `.catch(e => console.error("[webhook] persist failed:", e));

  // Buffer in memory
  let batch = pendingWebhookBatches.get(key);
  if (!batch) {
    batch = { orgId, events: [] };
    pendingWebhookBatches.set(key, batch);
  }
  batch.events.push({ type: eventType, payload });
}

async function signPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function deliverBatch(orgId: string, batchKey: string, events: { type: string; payload: unknown }[], onlyWebhookId?: string): Promise<void> {
  const webhooks = (await sql<{ id: string; url: string; secret: string; events: string[] }[]>`
    SELECT id, url, secret, events FROM common.webhooks WHERE org_id = ${orgId} AND enabled = true
  `).filter(wh => !onlyWebhookId || wh.id === onlyWebhookId);

  for (const wh of webhooks) {
    // Filter events this webhook subscribes to (empty = all)
    const matched = wh.events.length === 0
      ? events
      : events.filter(e => wh.events.includes(e.type));
    if (matched.length === 0) continue;

    const body = JSON.stringify({
      batchKey,
      events: matched,
      deliveredAt: new Date().toISOString(),
    });
    const signature = await signPayload(body, wh.secret);

    // Retry with exponential backoff
    let succeeded = false;
    const blocked = await webhookTargetError(wh.url);
    if (blocked) {
      await sql`
        INSERT INTO common.webhook_deliveries (webhook_id, batch_key, event_count, attempt, error)
        VALUES (${wh.id}, ${batchKey}, ${matched.length}, 1, ${"not sent: " + blocked})
      `.catch(() => {});
    }
    for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES && !blocked; attempt++) {
      try {
        const res = await fetch(wh.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wren-Signature": signature,
            "X-Wren-Delivery": batchKey,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });

        await sql`
          INSERT INTO common.webhook_deliveries (webhook_id, batch_key, event_count, attempt, status_code)
          VALUES (${wh.id}, ${batchKey}, ${matched.length}, ${attempt}, ${res.status})
        `.catch(() => {});

        if (res.ok) {
          await sql`UPDATE common.webhooks SET consec_failures = 0 WHERE id = ${wh.id}`.catch(() => {});
          succeeded = true;
          break;
        }
      } catch (err) {
        await sql`
          INSERT INTO common.webhook_deliveries (webhook_id, batch_key, event_count, attempt, error)
          VALUES (${wh.id}, ${batchKey}, ${matched.length}, ${attempt}, ${String(err).slice(0, 500)})
        `.catch(() => {});
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      if (attempt < WEBHOOK_MAX_RETRIES) {
        await Bun.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }

    if (!succeeded) {
      const [row] = await sql<{ consec_failures: number }[]>`
        UPDATE common.webhooks SET consec_failures = consec_failures + 1, updated_at = NOW()
        WHERE id = ${wh.id} RETURNING consec_failures
      `.catch(() => [{ consec_failures: 0 }]);
      if (row.consec_failures >= WEBHOOK_DISABLE_THRESHOLD) {
        await sql`UPDATE common.webhooks SET enabled = false, updated_at = NOW() WHERE id = ${wh.id}`.catch(() => {});
        console.warn(`[webhook] auto-disabled ${wh.id} after ${WEBHOOK_DISABLE_THRESHOLD} consecutive failures`);
      }
    }
  }
}

async function processWebhookBatches(): Promise<void> {
  const cutoff = Date.now() - WEBHOOK_BATCH_WINDOW_MS;
  const readyKeys: string[] = [];
  for (const [key] of pendingWebhookBatches) {
    const bucket = parseInt(key.split(":").pop()!);
    if (bucket * WEBHOOK_BATCH_WINDOW_MS < cutoff) readyKeys.push(key);
  }

  for (const key of readyKeys) {
    const batch = pendingWebhookBatches.get(key)!;
    pendingWebhookBatches.delete(key);
    deliverBatch(batch.orgId, key, batch.events).catch(e => {
      console.error("[webhook] delivery failed:", e);
    });
  }
}

async function recoverPendingWebhookBatches(): Promise<void> {
  // Find batches that were persisted but never delivered
  const rows = await sql<{ batch_key: string; org_id: string }[]>`
    SELECT DISTINCT we.batch_key, we.org_id
    FROM common.webhook_events we
    WHERE we.created_at > NOW() - INTERVAL '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM common.webhook_deliveries wd
        WHERE wd.batch_key = we.batch_key AND wd.status_code BETWEEN 200 AND 299
      )
  `.catch(() => []);

  for (const row of rows) {
    if (!pendingWebhookBatches.has(row.batch_key)) {
      const events = await sql<{ event_type: string; payload: unknown }[]>`
        SELECT event_type, payload FROM common.webhook_events
        WHERE batch_key = ${row.batch_key} ORDER BY id
      `.catch(() => []);
      if (events.length > 0) {
        pendingWebhookBatches.set(row.batch_key, {
          orgId: row.org_id,
          events: events.map(e => ({ type: e.event_type, payload: e.payload })),
        });
      }
    }
  }
}

async function purgeOldWebhookData(): Promise<void> {
  await sql`DELETE FROM common.webhook_events WHERE created_at < NOW() - INTERVAL '7 days'`.catch(() => {});
  await sql`DELETE FROM common.webhook_deliveries WHERE delivered_at < NOW() - INTERVAL '30 days'`.catch(() => {});
}

// ── Webhook CRUD handlers ────────────────────────────────────────────────────

async function handleListWebhooks(userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{
    id: string; url: string; events: string[]; enabled: boolean;
    consec_failures: number; created_at: Date; updated_at: Date;
  }[]>`
    SELECT id, url, events, enabled, consec_failures, created_at, updated_at
    FROM common.webhooks WHERE org_id = ${orgId} ORDER BY created_at
  `;
  return Response.json({
    webhooks: rows.map(r => ({
      id: r.id, url: r.url, events: r.events, enabled: r.enabled,
      consecFailures: r.consec_failures, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}

async function handleCreateWebhook(req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  webhookOrgCache.clear();
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  // Check limit
  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM common.webhooks WHERE org_id = ${orgId}
  `;
  if (parseInt(count) >= WEBHOOK_MAX_PER_ORG) {
    return Response.json({ error: `Maximum ${WEBHOOK_MAX_PER_ORG} webhooks per org` }, { status: 400 });
  }

  const body = await req.json() as { url?: string; events?: string[] };
  if (!body.url) return Response.json({ error: "url is required" }, { status: 400 });

  const urlError = await webhookTargetError(body.url);
  if (urlError) {
    return Response.json({ error: urlError }, { status: 400 });
  }

  const secret = randomHex(32);
  const events = Array.isArray(body.events) ? body.events.filter(e => typeof e === "string") : [];

  const [row] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO common.webhooks (org_id, url, secret, events)
    VALUES (${orgId}, ${body.url}, ${secret}, ${events})
    RETURNING id, created_at
  `;

  return Response.json({
    id: row.id, url: body.url, events, secret, enabled: true,
    consecFailures: 0, createdAt: row.created_at,
  }, { status: 201 });
}

async function handleUpdateWebhook(webhookId: string, req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  webhookOrgCache.clear();
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const body = await req.json() as { url?: string; events?: string[]; enabled?: boolean };

  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [];
  if (body.url !== undefined) {
    const urlError = await webhookTargetError(body.url);
    if (urlError) return Response.json({ error: urlError }, { status: 400 });
    params.push(body.url); sets.push(`url = $${params.length}`);
  }
  if (body.events !== undefined) {
    params.push(body.events); sets.push(`events = $${params.length}`);
  }
  if (body.enabled !== undefined) {
    params.push(body.enabled); sets.push(`enabled = $${params.length}`);
    if (body.enabled) { sets.push("consec_failures = 0"); } // re-enable resets failures
  }

  params.push(webhookId, orgId);
  const rows = await sql.unsafe<{ id: string }[]>(
    `UPDATE common.webhooks SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND org_id = $${params.length} RETURNING id`,
    params,
  );
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: webhookId, updated: true });
}

async function handleDeleteWebhook(webhookId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  webhookOrgCache.clear();
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const rows = await sql<{ id: string }[]>`
    DELETE FROM common.webhooks WHERE id = ${webhookId} AND org_id = ${orgId} RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: webhookId, deleted: true });
}

async function handleGetWebhookDeliveries(webhookId: string, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  // Verify webhook belongs to this org
  const [wh] = await sql<{ id: string }[]>`SELECT id FROM common.webhooks WHERE id = ${webhookId} AND org_id = ${orgId}`;
  if (!wh) return Response.json({ error: "Not found" }, { status: 404 });

  const rows = await sql<{
    id: string; batch_key: string; event_count: number; attempt: number;
    status_code: number | null; error: string | null; delivered_at: Date;
  }[]>`
    SELECT id, batch_key, event_count, attempt, status_code, error, delivered_at
    FROM common.webhook_deliveries WHERE webhook_id = ${webhookId}
    ORDER BY delivered_at DESC LIMIT 100
  `;

  return Response.json({
    deliveries: rows.map(r => ({
      id: r.id, batchKey: r.batch_key, eventCount: r.event_count, attempt: r.attempt,
      statusCode: r.status_code, error: r.error, deliveredAt: r.delivered_at,
    })),
  });
}

async function handleReplayWebhook(webhookId: string, req: Request, userId: string, sessionId: string | null, keyOrgId?: string): Promise<Response> {
  const orgId = await resolveUserOrgId(userId, sessionId, keyOrgId);
  const guard = await forbiddenIfNotAdminOrOwner(userId, orgId);
  if (guard) return guard;

  const [wh] = await sql<{ id: string }[]>`SELECT id FROM common.webhooks WHERE id = ${webhookId} AND org_id = ${orgId}`;
  if (!wh) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json() as { since?: string; until?: string };
  if (!body.since) return Response.json({ error: "since is required (ISO date)" }, { status: 400 });

  const since = new Date(body.since);
  const until = body.until ? new Date(body.until) : new Date();

  // Re-enqueue matching events with a new batch key
  const events = await sql<{ event_type: string; payload: unknown }[]>`
    SELECT event_type, payload FROM common.webhook_events
    WHERE org_id = ${orgId} AND created_at >= ${since} AND created_at <= ${until}
    ORDER BY id
  `;

  if (events.length === 0) return Response.json({ replayed: 0 });

  // Sent now, as one batch, to this webhook only (not through the batching window,
  // and not to the org's other webhooks)
  const replayKey = `${orgId}:replay:${Date.now()}`;
  deliverBatch(orgId, replayKey, events.map(e => ({ type: e.event_type, payload: e.payload })), webhookId)
    .catch(e => console.error("[webhook] replay failed:", e));

  return Response.json({ replayed: events.length, batchKey: replayKey });
}

// -------------------------------------------------------
// Simple flat JSON diff
// -------------------------------------------------------

type DiffEntry = { op: "add" | "remove" | "replace"; path: string; value?: unknown; oldValue?: unknown };

/**
 * Diff two documents as JSON-Pointer paths (RFC 6901). By default only top-level fields
 * are compared (a changed nested object is one "replace"); with deep, nested objects
 * and arrays are walked so each changed leaf is its own entry.
 */
function computeDiff(before: Record<string, unknown>, after: Record<string, unknown>, deep = false): DiffEntry[] {
  const diff: DiffEntry[] = [];
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    if (deep || depth === 0) {
      if (isObj(a) && isObj(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const p = `${path}/${esc(k)}`;
          if (!Object.hasOwn(a, k)) diff.push({ op: "add", path: p, value: b[k] });
          else if (!Object.hasOwn(b, k)) diff.push({ op: "remove", path: p, oldValue: a[k] });
          else walk(a[k], b[k], p, depth + 1);
        }
        return;
      }
      if (deep && Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const p = `${path}/${i}`;
          if (i >= a.length) diff.push({ op: "add", path: p, value: b[i] });
          else if (i >= b.length) diff.push({ op: "remove", path: p, oldValue: a[i] });
          else walk(a[i], b[i], p, depth + 1);
        }
        return;
      }
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push({ op: "replace", path, value: b, oldValue: a });
  };
  walk(before ?? {}, after ?? {}, "", 0);
  return diff;
}

export default server;

wlog(`Wren listening on http://localhost:${server.port}`);
wlog(`API docs available at http://localhost:${server.port}/docs`);
