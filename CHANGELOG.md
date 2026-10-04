# Changelog

All notable changes to the WREN server (`reusr1/wren`). Dates are release dates.

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
