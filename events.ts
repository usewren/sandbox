// Live change events: Server-Sent Events streams and the webhook feed.
//
// Every committed write in a tenant schema sends a NOTIFY on 'wren_changes' (trigger
// common.wren_notify_change, db migrations common/014 + tenant/013). One LISTEN
// connection turns those into change events, keeps the last few per org for resume,
// fans them out to stream subscribers, and hands each one to the webhook queue.
//
// Streams carry ids, versions and label names, never document data: a client reacts
// by re-reading what changed through the normal (permission-checked) API.

import type { Sql } from "postgres";

export type Change = {
  type: string;                 // document.created|updated|deleted, label.set|removed, tree.assigned|removed, schema.updated
  collection?: string;
  id?: string;                  // document id
  version?: number;
  key?: string;                 // natural key, if the collection has one
  label?: string;
  trees?: { tree: string; path: string }[]; // label events: where the document is mounted
  tree?: string;
  path?: string;
  removed?: boolean;            // schema.updated: the schema was deleted
  at: string;
};

type Stored = { seq: number; change: Change };

/** Access as checkAccess reports it, reduced to what visibility needs. */
export type Access = { allowed: boolean; labelFilter?: string; filterExpr?: string };

export type Subscriber = {
  orgId: string;
  /** Access to "collection:<name>" or "tree:<name>" for this subscriber (cached here). */
  access: (resource: string) => Promise<Access>;
  collections: Set<string> | null; // null = no collection filter
  trees: Set<string> | null;       // null = no tree filter
  send: (chunk: string) => void;
  chain: Promise<void>;           // deliveries run in order, one at a time
  replaying: Stored[] | null;     // events that arrive while a resume replays
};

const BUFFER_PER_ORG = 1000;
const MAX_SUBSCRIBERS = Number(process.env.WREN_EVENTS_MAX_STREAMS ?? "2000");
const MAX_PER_ORG = Number(process.env.WREN_EVENTS_MAX_STREAMS_PER_ORG ?? "200");
const HEARTBEAT_MS = 25_000;
const ACCESS_CACHE_MS = 30_000;

const BOOT = Date.now().toString(36);  // ids from an earlier process can't be resumed
let seq = 0;
const buffers = new Map<string, Stored[]>();
const subscribers = new Set<Subscriber>();
const schemaToOrg = new Map<string, string>();

function fromNotify(m: Record<string, unknown>): Change {
  const c: Change = { type: String(m.t), at: new Date().toISOString() };
  if (m.c != null) c.collection = String(m.c);
  if (m.d != null) c.id = String(m.d);
  if (m.v != null) c.version = Number(m.v);
  if (m.k != null) c.key = String(m.k);
  if (m.l != null) c.label = String(m.l);
  if (Array.isArray(m.p)) c.trees = (m.p as [string, string][]).map(([tree, path]) => ({ tree, path }));
  if (m.tree != null) c.tree = String(m.tree);
  if (m.path != null) c.path = String(m.path);
  if (m.removed) c.removed = true;
  return c;
}

/** Start listening. onChange runs for every event (the webhook queue). */
export async function startEvents(sql: Sql, onChange: (orgId: string, change: Change) => void | Promise<void>): Promise<void> {
  async function orgFor(schema: string): Promise<string | undefined> {
    if (!schemaToOrg.has(schema)) {
      const rows = await sql<{ org_id: string; schema_name: string }[]>`SELECT org_id, schema_name FROM common.tenant_versions`;
      for (const r of rows) schemaToOrg.set(r.schema_name, r.org_id);
    }
    return schemaToOrg.get(schema);
  }
  await sql.listen("wren_changes", async (payload) => {
    try {
      const m = JSON.parse(payload) as Record<string, unknown>;
      const orgId = await orgFor(String(m.s));
      if (!orgId) return;
      const change = fromNotify(m);
      const stored = { seq: ++seq, change };
      let buf = buffers.get(orgId);
      if (!buf) { buf = []; buffers.set(orgId, buf); }
      buf.push(stored);
      if (buf.length > BUFFER_PER_ORG) buf.splice(0, buf.length - BUFFER_PER_ORG);
      Promise.resolve(onChange(orgId, change)).catch(() => {});
      for (const sub of subscribers) if (sub.orgId === orgId) enqueue(sub, stored);
    } catch (e) {
      console.error("[events] bad notification:", e);
    }
  });
}

/**
 * What this subscriber may see of a change, or null. Collections and trees are
 * checked separately; label events are visible through either. A rule with a label
 * filter only lets that label's moves through (other versions aren't visible to
 * it), and a rule with a data filter sends nothing, since an id alone could reveal
 * a document the filter hides.
 */
export async function visibleChange(sub: Subscriber, c: Change): Promise<Change | null> {
  const ok = (a: Access, label?: string) => a.allowed && !a.filterExpr && (!a.labelFilter || a.labelFilter === label);
  const wantColl = (name?: string) => !!name && (sub.collections ? sub.collections.has(name) : !sub.trees);
  const wantTree = (name: string) => sub.trees ? sub.trees.has(name) : !sub.collections;

  if (c.type === "tree.assigned" || c.type === "tree.removed") {
    if (!c.tree || !wantTree(c.tree)) return null;
    const a = await sub.access(`tree:${c.tree}`);
    // With a label filter a new path may point at an unreleased page: don't announce it
    return a.allowed && !a.filterExpr && !a.labelFilter ? c : null;
  }

  if (c.type === "label.set" || c.type === "label.removed") {
    const trees: { tree: string; path: string }[] = [];
    for (const t of c.trees ?? []) {
      if (wantTree(t.tree) && ok(await sub.access(`tree:${t.tree}`), c.label)) trees.push(t);
    }
    const viaCollection = wantColl(c.collection) && ok(await sub.access(`collection:${c.collection}`), c.label);
    if (!viaCollection && !trees.length) return null;
    return { ...c, trees };
  }

  // document.* and schema.updated: only for rules that show every version
  if (!wantColl(c.collection)) return null;
  const a = await sub.access(`collection:${c.collection}`);
  return a.allowed && !a.filterExpr && !a.labelFilter ? c : null;
}

function enqueue(sub: Subscriber, s: Stored): void {
  if (sub.replaying) { sub.replaying.push(s); return; }
  sub.chain = sub.chain.then(() => deliver(sub, s)).catch(() => {});
}

async function deliver(sub: Subscriber, s: Stored): Promise<void> {
  const v = await visibleChange(sub, s.change);
  if (v) sub.send(`id: ${BOOT}-${s.seq}\ndata: ${JSON.stringify(v)}\n\n`);
}

/** Cache access decisions for a stream's lifetime (rules can change: 30 s). */
export function cachedAccess(check: (resource: string) => Promise<Access>): (resource: string) => Promise<Access> {
  const cache = new Map<string, { at: number; a: Promise<Access> }>();
  return resource => {
    const hit = cache.get(resource);
    if (hit && Date.now() - hit.at < ACCESS_CACHE_MS) return hit.a;
    const a = check(resource).catch(() => ({ allowed: false }));
    cache.set(resource, { at: Date.now(), a });
    return a;
  };
}

const list = (v: string | null) => v ? new Set(v.split(",").map(s => s.trim()).filter(Boolean)) : null;

/** Open an SSE stream. `check` answers access for this caller in orgId. */
export function openStream(req: Request, url: URL, orgId: string, check: (resource: string) => Promise<Access>, extraHeaders: Record<string, string> = {}): Response {
  const perOrg = [...subscribers].filter(s => s.orgId === orgId).length;
  if (subscribers.size >= MAX_SUBSCRIBERS || perOrg >= MAX_PER_ORG) {
    return Response.json({ error: "Too many open event streams; try again later" }, { status: 503, headers: { "Retry-After": "30", ...extraHeaders } });
  }
  const enc = new TextEncoder();
  let sub: Subscriber | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (sub) subscribers.delete(sub);
    if (timer) clearInterval(timer);
    sub = null; timer = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => { try { controller.enqueue(enc.encode(chunk)); } catch { close(); } };
      sub = {
        orgId, access: cachedAccess(check),
        collections: list(url.searchParams.get("collections")),
        trees: list(url.searchParams.get("trees")),
        send, chain: Promise.resolve(), replaying: [],
      };
      subscribers.add(sub);
      send(`retry: 3000\n\n`);

      // Resume after a reconnect: replay what was missed, or tell the client to re-read
      const last = req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
      const s = sub;
      const upTo = seq; // events after this arrive through s.replaying
      (async () => {
        if (last) {
          const [boot, n] = last.split("-");
          const buf = buffers.get(orgId) ?? [];
          const after = Number(n);
          if (boot === BOOT && (buf.length === 0 || buf[0].seq <= after + 1)) {
            for (const st of buf) if (st.seq > after && st.seq <= upTo) await deliver(s, st);
          } else {
            send(`data: ${JSON.stringify({ type: "reset", at: new Date().toISOString() })}\n\n`);
          }
        }
        send(`data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);
        // Now live: deliver what arrived meanwhile, in order
        const pending = s.replaying ?? [];
        s.replaying = null;
        for (const st of pending) enqueue(s, st);
      })().catch(close);

      timer = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => { close(); try { controller.close(); } catch {} });
    },
    cancel() { close(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
      ...extraHeaders,
    },
  });
}

export function eventStats() {
  return { streams: subscribers.size, buffered: [...buffers.values()].reduce((n, b) => n + b.length, 0) };
}
