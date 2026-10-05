# Changelog

All notable changes to the WREN server (`reusr1/wren`). Dates are release dates.

## 0.9.0 — 2026-10-05

Gaps found while writing the case studies (tournament tracker, MAE stock tracker, data.tkd-scores.com, task tracker, AI-maintained sites, test fixtures).

### Added
- **Unchanged writes create no version.** A `PUT` (or upsert by key) whose JSON equals the current version — compared by meaning — returns `200` with the current version and `unchanged: true`. On real deployments about half of all updates were identical re-sends. `?force=true` writes a version anyway.
- **Restore a collection or tree to a label** in one transaction: `POST /api/v1/{collection}/_restore` and `POST /api/v1/tree/{name}/_restore` with `{label, deleteUnlabeled?}`. Changed documents get the labeled content as a new version, deleted ones come back, and documents made since can be deleted. For resetting test fixtures and undoing bad imports or releases.
- **Undelete:** `POST /api/v1/{collection}/{id}/undelete` (emits `document.undeleted`).
- **Remove a label:** `DELETE /api/v1/{collection}/{id}/labels/{label}`.
- **Deeper diffs:** `?deep=true` reports each changed nested field and array element; `v1`/`v2` accept label names.
- **Setting a natural key registers keys for existing documents** (`keysRegistered` in the response), so by-key reads and upserts find them instead of creating duplicates. If two live documents would share a key, the schema change is refused with `409` listing the clashes. An unchanged write still updates a document's stored key.
- **Files by name:** a file collection with `naturalKey: "filename"` supports `PUT …/by-key/{name}` (multipart: create, replace or unchanged), `GET …/by-key/{name}/raw`, and refuses a duplicate name with `409`.

### Changed
- Range filters (`>`, `>=`, `<`, `<=`) compare numbers numerically and anything else as text, so ISO dates filter correctly (they used to fail on non-numbers).

### Fixed
- Rolling back a file restored its metadata but not its bytes (the current version then had no file). A rollback now points the new version at the old version's blob, and the natural key follows the restored data.

## 0.8.0 — 2026-10-05

### Added
- **Files are stored once per content.** Bytes move to `asset_blobs`, keyed by SHA-256; each version points at its blob, so history is unchanged but identical bytes take space once. Re-uploading a file whose bytes, name and type equal the current version returns `200` with `unchanged: true` and creates no version.
- **Retention policies.** An org default and per-collection policies (`GET/PUT/DELETE /api/v1/retention[/{collection|*}]`, `POST …/_preview`, `POST /api/v1/retention/_apply`), applied hourly. Rules combine (a version goes if any says so): keep only labeled versions, keep the newest n, remove older than n days, remove older than a label's version. A document's current version and every labeled version are always kept. Blobs are deleted only when no version references them, enforced by a foreign key; runs are logged.

### Fixed
- Two concurrent uploads to the same file can no longer take the same version number (the document row is locked).

### Upgrade notes
- Migration tenant/014 rebuilds each org's file table around the shared blobs (on a copy of the production data: 23,274 file versions, 2.8 GB → 1.3 GB, every file byte-identical, about 20 s). Common/015 adds the policy and run tables. Nothing is removed until an admin sets a policy.

## 0.7.0 — 2026-10-05

### Removed
- **The old React admin UI (`/oldadmin`)** and the React `componentlibrary` it used. They are no longer built into the image; `/oldadmin` redirects to `/admin/`. The server, Admin UI and wren.js are plain JavaScript/TypeScript with no React.

### Security
- **`?depth=` could reveal private documents.** `$ref` resolution looked up referenced documents in any collection or tree of the org without an access check, so a public document referencing a private one showed the private data to anyone. References now follow the reader's own rules (including label filters); one they can't read resolves to `{ "$ref": "…", "$forbidden": true }`.
- **Members could read every collection through `llms.txt`.** An org's `llms.txt` treated every member (and narrowed keys) like the owner. Each reader now sees only what their own rules allow; only the owner's own session sees everything, and a key from another org gets the public view.
- **The owner's API keys couldn't be narrowed.** The owner bypass ran before a key's own `key:` rules, so a read-only owner key could still write. Key rules now narrow the owner's keys too.
- **Label filters were bypassed by version history.** A reader whose rule only shows `published` could read any version and diff. Under a label-filtered rule the version list, versions and diffs return 403; under a rule with a data filter, diffs do.
- **Webhook address check bypassed with IPv6 forms of internal addresses** (`[::ffff:127.0.0.1]`, NAT64, 6to4). IPv6 addresses are now parsed fully and embedded IPv4 addresses checked.
- `/api/v1/projects` no longer lists collections that a public `none` rule closes.
- Cookie-based `/api/auth` POSTs from untrusted origins are refused (403), so another site can't sign a visitor in or out.
- **Webhooks can't reach private addresses.** Any org owner could register a webhook pointing at the server's own network (the database, other containers, `169.254.169.254`), and the delivery log's status codes showed what answered. URLs must now be `http(s)` and resolve to public addresses, checked on save and before every delivery; redirects aren't followed. Internal receivers can be allowed by host name with `WREN_WEBHOOK_ALLOW_HOSTS`.

### Added
- **Live events (Server-Sent Events).** `GET /api/v1/_events` streams committed changes you can read; `GET /api/v1/orgs/{slug}/_events` (and `/orgs/{slug}/_events`) streams public changes to anyone, following the public rules (with `labelFilter: published` only `published` moves). Filters `?collections=` and `?trees=`; resume with `Last-Event-ID`. Events carry ids, versions, label names and tree paths, never data.
- Changes come from a database trigger (migrations common/014, tenant/013) and arrive after commit, so every write path is covered: REST, by-key upserts, uploads, tree promote and MCP.

### Fixed
- **Webhooks come from the same change feed**, so payloads are complete: `document.created` now includes the document `id` (documented but missing), every document event carries `version`, `label.set` says which label moved and to which version, and `schema.updated` (documented, never sent) is sent. New type `label.removed`. A rollback is reported as `document.updated` (the old `rollback: true` flag is gone).
- Orgs without webhooks no longer store an event row for every write.
- **Index declarations created nothing, and could leave a connection pointed at a tenant.** Declared indexes ran `SET search_path` on one pooled connection and the DDL on another, so `CREATE INDEX` failed (only logged) and the setting stayed on that pooled connection. They now run in one transaction with `SET LOCAL`.
- **Public `llms.txt` listed unreleased tree paths.** For a tree whose public rule shows only `published`, the Trees section now lists only released pages; it also names each page's collection instead of `_paths`.
- Old versions and diffs of a deleted document are no longer readable (the version list already returned 404).
- `?where=`: the documented `!~*` operator works (it was read as `~*`), values containing `:` or `=` no longer cut the path short, and `@>` containment matches (the JSON value was encoded twice; nested paths returned 500).
- `_query` cursor paging visits every document once (it sorted by time but paged by random id).
- `avg` (and every `count`/`sum`) metric is a number, not a string like `"2024.5000000000000000"`.
- A rollback refreshes materialized queries like any other write.
- `$ref`: the same document referenced twice resolves both times; only a reference to one of its own ancestors is `$circular`.
- Tree reads: `_` and `%` in a path match themselves instead of acting as wildcards.
- Replaying a webhook delivers the events (they were queued forever), and only to that webhook (not every webhook of the org).
- Removed members can't read the org's usage.
- A tree alias serves the requested path (it always served the root); a duplicate alias is a 409 (was a 500).
- Moving an existing label or path while impersonating records the impersonating admin.
- Rules: a filter expression that doesn't compile is refused when the rule is saved (it used to turn every read into null). Invites: the address must be an email.
- A request body that isn't valid JSON is a 400 everywhere (was a 500); assigning an unknown document to a tree path is a 404 (was a 500). Unexpected errors return a JSON 500 with CORS headers.

### Upgrade notes
- Migrations common/014 and tenant/013 run on start (change-notification triggers). No data changes.
- **Webhooks:** payloads gain fields (`id` on every document event, `version`, `label`, `trees`, `key`); a rollback arrives as `document.updated` without the old `rollback` flag. Webhooks pointing at private or local addresses stop delivering (the delivery log says why); allow internal receivers with `WREN_WEBHOOK_ALLOW_HOSTS`.
- **`$ref` with `?depth=`:** references into collections or trees the reader can't read now resolve to `{ "$ref": …, "$forbidden": true }` instead of the data.
- **Label-filtered rules:** version history and diffs return 403 under them.
- `/oldadmin` redirects to `/admin/`.

## 0.6.0 — 2026-10-04

### Security
- **Permission rules are unique per org.** Rules were unique on `(principal, resource)` across all orgs, so two orgs with a same-named tree or collection could collide; creating a rule in one org could fail or touch the other's. Now unique on `(org_id, principal, resource)`.
- **Invites only work for the invited email address.**

### Added
- **Groups.** Every org gets *Editors* (write everything) and *Viewers* (read everything); create your own. Invite people straight into groups. Rules can name `group:<id>`; the most specific resource wins, then personal over group, then the highest access.
- **API keys act as their creator** in the key's org, unless the key has `key:<id>` rules of its own (which then narrow it). Members manage their own keys; admins all.
- **Org-admin impersonation** ("View as"): an admin sees the org as one member, inside that org only, with a banner. Every change made that way records `impersonated_by` on the version, label and path, and in the access log. Keys, permissions, invites, members, groups, webhooks, org settings and connected apps are blocked while impersonating.
- **Public data over MCP.** `/mcp` without a key is open, read-only, to every org's public data (`list_public`, `public_*` tools); keyed sessions get the public tools too.
- **"Sign in with WREN" for MCP clients.** `/mcp/login`: OAuth 2.1 with PKCE and dynamic client registration. WREN always shows its consent page, where the user picks the org; the client then acts as that user there. Tokens are MCP-only.
- **Connected apps:** `GET/DELETE /api/v1/connected-apps[/{clientId}]` and *Settings → Connected apps* list and revoke MCP sign-ins; revoking stops the app immediately.
- **Landing-page experiment:** `/` serves one of `/a`–`/e` per visitor (`WREN_LANDING_VARIANTS`); anonymous counts per variant; results at `/stats/landing` for `WREN_OPERATORS`. New AI-first variant at `/e`.
- Docs: homepage section on AI agents and teamwork, concepts section on people/groups/agents, self-hosting configuration reference in `llms-full.txt`.

### Changed
- An API key with no `key:` rules of its own now has its creator's access in the key's org. Before, such a key was denied everywhere except in its creator's own org. A key whose creator has left the org gets nothing.

### Upgrade notes
- Migrations `011`–`013` run on start (groups, impersonation audit columns, OAuth tables, landing counts). Existing members aren't added to any group, so their access is unchanged; the org owner keeps full access. Each org's *Editors* and *Viewers* groups are created the first time an admin opens the groups list or sends an invite.
- Set `WREN_OPERATORS` to see `/stats/landing`; set `WREN_LANDING_VARIANTS=c` to keep the previous homepage for everyone.

## 0.5.0 — 2026-10-04

### Security
- **Raw file reads are scoped to their collection.** A public read rule on one collection could be used to fetch raw bytes of a document in another, private collection by id (`…/{id}/raw?version=N`). Every raw read now checks the collection and honors the rule's label filter.
- **Label filters can't be bypassed on lists.** On public list URLs, `?label=` (including an empty value) overrode a rule's `labelFilter: "published"`, exposing unpublished versions. The rule's filter now always wins, as it already did for single documents, trees and `_query`.
- **Authenticated responses are never shared-cacheable.** File and tree responses were `Cache-Control: public` even when fetched with a key, so a CDN could serve a private `.js`/`.css`/`.png` to anonymous visitors. All authenticated `/api/v1` responses are now `private, no-store`.
- **API keys act in their own org** for org, invite, member, permission and webhook routes (previously the key owner's personal org).
- **CORS:** public routes allow any origin; the private API accepts `Authorization: Bearer` from any origin, but cookies only from trusted origins. Foreign origins are not echoed on `/api/auth/*`.
- Public org `llms.txt` samples respect label and data filters and skip collections a rule denies; owner/member views are `private, no-store`.

### Added
- **MCP server for AI agents.** `POST /mcp`: org from the API key, 12 tools (query, read, write to a `preview` label, diff, atomic promote), `?readonly=1`. `POST /orgs/{slug}/mcp`: org-bound endpoint for custom domains; public and read-only without a key, scoped to one site with `?tree=`; with a key only for that org's keys.
- **Atomic tree promote:** `POST /api/v1/tree/{name}/_promote {label, from}` moves a label on every document in a tree in one transaction. `wren promote` uses it.
- **Email:** account confirmation on sign-up, password reset (forgot/reset forms on `/login`), invite emails. Delivery via `SMTP_URL`/`MAIL_FROM`; without them, links are written to the server log. `REQUIRE_EMAIL_VERIFICATION=true` blocks unconfirmed sign-ins (default: send, don't block). Invite responses include `emailSent` and `acceptUrl`.
- Binary uploads store a `sha256` of the bytes in their metadata (used by `wren deploy` to detect same-size edits).
- Documentation pages: `/concepts`, `/guides` (go-live checklist, MCP, publishing, public URLs, idempotent writes, Python, custom domains, a case study), served as static HTML.

### Changed
- Public org URLs are read-only: writes return **405** instead of silently returning a list.
- Error responses on public routes, and tree paths with no visible version (deployed but not promoted), are `no-store` 404s, so a CDN stops serving a stale 404 after a deploy.
- Generated links (`/api/v1/projects`, `llms.txt`, sitemap, robots) use `WREN_URL`/`BETTER_AUTH_URL` instead of the request URL (`https://` behind a proxy). The projects `url` points at `/orgs/{slug}/llms.txt` (was a 404).
- `/health` reports the image's build id (`WREN_BUILD` build arg) instead of a fixed string.

### Fixed
- Multipart upload responses include the file metadata (`data`) again.

### Docs
- `llms.txt` / `llms-full.txt` rewritten around a URL map: every authenticated route is under `/api/v1` (the previous unversioned and `/api/...` routes returned 404). OpenAPI documents principal `*`, atomic promote and caching.

## 0.4.2

Previous release.
