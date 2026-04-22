# WREN Server

The core server for [WREN](https://wren.aemwip.com) — versioned JSON storage and static site deployment.

This is the main application: a Bun/TypeScript HTTP server that provides the REST API, serves the Admin UI, marketing site, and handles authentication. It's the single process inside the `reusr1/wren` Docker image.

## What's in here

- REST API for documents, versions, labels, trees, schemas, binary assets, permissions
- Binary asset serving with content negotiation (JSON or raw bytes based on `Accept` header)
- Label-aware tree paths (`?label=published` for preview/promote workflows)
- Multi-tenant Postgres isolation (one schema per org)
- Better Auth integration (email/password, session cookies, API keys)
- Marketing site, tutorials, `/projects` directory, `/docs` (Scalar), `llms.txt`

## Quick start

```bash
# With Docker (recommended)
docker compose up -d
# Server at http://localhost:4000

# Without Docker (needs Bun + Postgres)
bun install
DATABASE_URL=postgres://... bun run index.ts
```

## Docker image

```bash
docker pull reusr1/wren:latest
# or: reusr1/wren:0.4.2
# Platforms: linux/amd64, linux/arm64
```

## Related repos

All repos live under [github.com/usewren](https://github.com/usewren):

| Repo | Description |
|---|---|
| **[sandbox](https://github.com/usewren/sandbox)** | Server (this repo) |
| [cli](https://github.com/usewren/cli) | CLI tool (`@usewren/cli` on npm) |
| [adminui2](https://github.com/usewren/adminui2) | Admin UI (vanilla JS) |
| [marketing](https://github.com/usewren/marketing) | Landing pages, tutorials, llms.txt |
| [docs](https://github.com/usewren/docs) | OpenAPI 3.1 spec |
| [db](https://github.com/usewren/db) | Postgres migrations |
| [auth](https://github.com/usewren/auth) | Better Auth configuration |
| [client-ts](https://github.com/usewren/client-ts) | TypeScript client library |
| [client-py](https://github.com/usewren/client-py) | Python client library |

## Links

- **Website:** https://wren.aemwip.com
- **Tutorial:** https://wren.aemwip.com/tutorial
- **Deploy tutorial:** https://wren.aemwip.com/tutorial/deploy
- **API Docs:** https://wren.aemwip.com/docs
- **Projects:** https://wren.aemwip.com/projects
- **npm:** [@usewren/cli](https://www.npmjs.com/package/@usewren/cli)

## License

Apache-2.0
