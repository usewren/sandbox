// Version retention: org-wide and per-collection policies that remove old versions.
//
// A document's current version and every version a label points to are always kept.
// Of the rest, a version is removed when any rule of the collection's policy says so:
//   labeledOnly   keep only labeled versions
//   maxVersions   keep the newest n versions (counting the current one)
//   maxAgeDays    remove versions older than n days
//   afterLabel    remove versions older than the version this label points to
// A collection's own policy replaces the org default ('*'); a policy with no rule
// keeps everything. File bytes are shared by hash (asset_blobs), so a blob goes only
// when no remaining version points at it. Internal collections ("_…") are never touched.

import type { Sql } from "postgres";

export type Policy = {
  labeledOnly: boolean;
  maxVersions: number | null;
  maxAgeDays: number | null;
  afterLabel: string | null;
};

export type Plan = { collection: string; versions: number; documents: number; bytes: number };

type WithTenant = <T>(schemaName: string, fn: (tx: Sql) => Promise<T>) => Promise<T>;

const BATCH = 5000; // versions removed per transaction

export function hasRules(p: Policy): boolean {
  return p.labeledOnly || p.maxVersions != null || p.maxAgeDays != null || p.afterLabel != null;
}

/** Validate a policy from a request body; returns the policy or an error message. */
export function parsePolicy(body: unknown): Policy | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "The policy must be a JSON object";
  const b = body as Record<string, unknown>;
  return parseFields(b);
}

function parseFields(body: Record<string, unknown>): Policy | string {
  const int = (k: string) => {
    const v = body[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return NaN;
    return v;
  };
  const maxVersions = int("maxVersions"), maxAgeDays = int("maxAgeDays");
  if (Number.isNaN(maxVersions)) return "maxVersions must be a whole number of at least 1 (or null)";
  if (Number.isNaN(maxAgeDays)) return "maxAgeDays must be a whole number of at least 1 (or null)";
  if (body.labeledOnly !== undefined && typeof body.labeledOnly !== "boolean") return "labeledOnly must be true or false";
  const afterLabel = body.afterLabel ?? null;
  if (afterLabel !== null && (typeof afterLabel !== "string" || !afterLabel.trim())) return "afterLabel must be a label name (or null)";
  return { labeledOnly: body.labeledOnly === true, maxVersions, maxAgeDays, afterLabel: afterLabel ? (afterLabel as string).trim() : null };
}

type PolicyRow = { collection: string; labeled_only: boolean; max_versions: number | null; max_age_days: number | null; after_label: string | null; updated_at: Date; updated_by: string | null };
export const fromRow = (r: PolicyRow): Policy =>
  ({ labeledOnly: r.labeled_only, maxVersions: r.max_versions, maxAgeDays: r.max_age_days, afterLabel: r.after_label });

export async function orgPolicies(sql: Sql, orgId: string): Promise<PolicyRow[]> {
  return sql<PolicyRow[]>`
    SELECT collection, labeled_only, max_versions, max_age_days, after_label, updated_at, updated_by
    FROM common.retention_policies WHERE org_id = ${orgId} ORDER BY collection
  `;
}

/** The policy each data collection of the org follows: its own, else the default. */
export async function effectivePolicies(sql: Sql, withTenant: WithTenant, schemaName: string, orgId: string): Promise<{ collection: string; policy: Policy; source: "collection" | "default" }[]> {
  const rows = await orgPolicies(sql, orgId);
  if (!rows.length) return [];
  const byName = new Map(rows.map(r => [r.collection, fromRow(r)]));
  const collections = await withTenant(schemaName, tx => tx<{ collection: string }[]>`
    SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE '\\_%' ORDER BY collection
  `);
  const out: { collection: string; policy: Policy; source: "collection" | "default" }[] = [];
  for (const { collection } of collections) {
    const own = byName.get(collection);
    const policy = own ?? byName.get("*");
    if (policy) out.push({ collection, policy, source: own ? "collection" : "default" });
  }
  return out;
}

// The versions a policy removes in one collection, as a temp table "doomed".
async function selectDoomed(tx: Sql, collection: string, p: Policy, limit: number | null): Promise<void> {
  await tx`
    CREATE TEMP TABLE doomed ON COMMIT DROP AS
    WITH v AS (
      SELECT v.document_id, v.version, v.created_at, d.current_version,
             row_number() OVER (PARTITION BY v.document_id ORDER BY v.version DESC) AS rank,
             (SELECT l.version FROM labels l WHERE l.document_id = v.document_id AND l.label = ${p.afterLabel}) AS after_version,
             EXISTS (SELECT 1 FROM labels l WHERE l.document_id = v.document_id AND l.version = v.version) AS labeled
      FROM versions v JOIN documents d ON d.id = v.document_id
      WHERE d.collection = ${collection}
    )
    SELECT document_id, version FROM v
    WHERE version <> current_version AND NOT labeled
      AND (${p.labeledOnly}
        OR (${p.maxVersions}::int IS NOT NULL AND rank > ${p.maxVersions}::int)
        OR (${p.maxAgeDays}::int IS NOT NULL AND created_at < NOW() - make_interval(days => ${p.maxAgeDays}::int))
        OR (after_version IS NOT NULL AND version < after_version))
    ORDER BY document_id, version
    LIMIT ${limit ?? 2147483647}
  `;
  await tx`CREATE INDEX ON doomed (document_id, version)`;
}

/** What a policy would remove from one collection (nothing is changed). */
export async function preview(withTenant: WithTenant, schemaName: string, collection: string, p: Policy): Promise<Plan> {
  if (!hasRules(p) || collection.startsWith("_")) return { collection, versions: 0, documents: 0, bytes: 0 };
  return withTenant(schemaName, async tx => {
    await selectDoomed(tx, collection, p, null);
    const [r] = await tx<{ versions: number; documents: number; json_bytes: string; blob_bytes: string }[]>`
      SELECT
        (SELECT count(*)::int FROM doomed) AS versions,
        (SELECT count(DISTINCT document_id)::int FROM doomed) AS documents,
        (SELECT coalesce(sum(pg_column_size(v.data)), 0)::text FROM versions v JOIN doomed USING (document_id, version)) AS json_bytes,
        -- blobs only removed versions point at
        (SELECT coalesce(sum(b.size), 0)::text FROM asset_blobs b
          WHERE EXISTS (SELECT 1 FROM asset_contents ac JOIN doomed USING (document_id, version) WHERE ac.sha256 = b.sha256)
            AND NOT EXISTS (SELECT 1 FROM asset_contents ac WHERE ac.sha256 = b.sha256
                              AND NOT EXISTS (SELECT 1 FROM doomed x WHERE x.document_id = ac.document_id AND x.version = ac.version))
        ) AS blob_bytes
    `;
    return { collection, versions: r.versions, documents: r.documents, bytes: Number(r.json_bytes) + Number(r.blob_bytes) };
  });
}

/** Remove what a policy says from one collection, in batches. */
export async function apply(withTenant: WithTenant, schemaName: string, collection: string, p: Policy): Promise<Plan> {
  const total: Plan = { collection, versions: 0, documents: 0, bytes: 0 };
  if (!hasRules(p) || collection.startsWith("_")) return total;
  const docs = new Set<string>();
  let refused = 0;
  for (;;) {
    // A blob is only deleted when no version points at it. The foreign key from
    // asset_contents makes Postgres refuse the delete if a reference appeared in the
    // meantime (an upload of the same bytes); then the whole batch rolls back — no
    // version is lost — and is tried again.
    const batch = await withTenant(schemaName, async tx => {
      await selectDoomed(tx, collection, p, BATCH);
      const ids = await tx<{ document_id: string }[]>`SELECT DISTINCT document_id FROM doomed`;
      const [{ json_bytes }] = await tx<{ json_bytes: string }[]>`
        SELECT coalesce(sum(pg_column_size(v.data)), 0)::text AS json_bytes FROM versions v JOIN doomed USING (document_id, version)
      `;
      await tx`DELETE FROM asset_contents ac USING doomed d WHERE ac.document_id = d.document_id AND ac.version = d.version`;
      const removed = await tx`DELETE FROM versions v USING doomed d WHERE v.document_id = d.document_id AND v.version = d.version`;
      const blobs = await tx<{ size: number }[]>`
        DELETE FROM asset_blobs b WHERE NOT EXISTS (SELECT 1 FROM asset_contents ac WHERE ac.sha256 = b.sha256)
        RETURNING size
      `;
      return { versions: removed.count, ids: ids.map(r => r.document_id), bytes: Number(json_bytes) + blobs.reduce((n, b) => n + b.size, 0) };
    }).catch(e => {
      if ((e as { code?: string })?.code === "23503" && ++refused <= 3) return null; // blob still referenced: retry
      throw e;
    });
    if (!batch) continue;
    total.versions += batch.versions;
    total.bytes += batch.bytes;
    batch.ids.forEach(id => docs.add(id));
    if (batch.versions < BATCH) break;
  }
  total.documents = docs.size;
  return total;
}

/** Apply every collection's policy for one org and log the runs that removed something. */
export async function applyOrg(sql: Sql, withTenant: WithTenant, schemaName: string, orgId: string, triggeredBy: string): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const { collection, policy } of await effectivePolicies(sql, withTenant, schemaName, orgId)) {
    const plan = await apply(withTenant, schemaName, collection, policy);
    if (plan.versions > 0) {
      plans.push(plan);
      await sql`
        INSERT INTO common.retention_runs (org_id, collection, versions_removed, bytes_freed, triggered_by)
        VALUES (${orgId}, ${collection}, ${plan.versions}, ${plan.bytes}, ${triggeredBy})
      `;
    }
  }
  return plans;
}

/** Hourly: apply the policies of every org that has one. */
export function scheduleRetention(sql: Sql, withTenant: WithTenant, schemaFor: (orgId: string) => string, everyMs = 3_600_000): void {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const orgs = await sql<{ org_id: string }[]>`SELECT DISTINCT org_id FROM common.retention_policies`;
      for (const { org_id } of orgs) {
        await applyOrg(sql, withTenant, schemaFor(org_id), org_id, "schedule").catch(e => console.error(`[retention] ${org_id}:`, e));
      }
    } finally {
      running = false;
    }
  }, everyMs);
}
