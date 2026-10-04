# Changelog

All notable changes to the WREN server (`reusr1/wren`). Dates are release dates.

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
