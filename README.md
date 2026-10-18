# Riffle

Free and open source small business bookkeeping software: multi-business,
double-entry, with automatic bank import via SimpleFIN, rules-based
categorization, reconciliation, and AI-assisted statement upload.

> **Status: Phase 0 (foundation).** The app currently serves a placeholder UI
> and a `/healthz` endpoint. The purpose of this phase is to prove the build,
> Docker image, and deployment pipeline end to end. See
> [docs/roadmap.md](docs/roadmap.md).

Licensed under the [AGPL-3.0-or-later](LICENSE).

## Run it with Docker

```bash
git clone https://github.com/fubarpie/riffle-accounting.git
cd riffle-accounting
cp .env.example .env
# edit .env and set POSTGRES_PASSWORD (for example: openssl rand -hex 24)
docker compose up -d
```

Open <http://localhost:3000>. Health check: `curl localhost:3000/healthz`.

Images are published to GHCR as `ghcr.io/fubarpie/riffle-accounting`:

| Tag | Meaning |
|---|---|
| `latest` | Latest build of `main` |
| `main` | Same as above, by branch name |
| `sha-<short>` | A specific commit (best for repeatable deploys) |
| `pr-<n>` | Build of pull request `n`, for testing before merge |
| `1.2.3`, `1.2` | Release tags |

Pin a tag by setting `RIFFLE_IMAGE` in `.env`.

One image runs two roles, chosen by `MODE`: `api` (web UI and API, the
default) and `worker` (background jobs). `docker-compose.yml` starts both plus
PostgreSQL.

## Develop

Requirements: Node 22, pnpm 9 (`corepack enable`), Docker.

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build

pnpm dev:api      # API on :3000
pnpm dev:web      # web UI on :5173, proxies to the API
```

Build and run your local checkout in Docker:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Run the same smoke test CI uses against any image:

```bash
scripts/smoke.sh riffle-accounting:dev
```

## Repository layout

```
apps/api         Fastify API; also serves the built web UI
apps/worker      Background worker (health endpoint only in Phase 0)
apps/web         React + Vite UI
packages/shared  Types and helpers shared by all apps
docker/          Dockerfile and entrypoint
docs/adr/        Architecture decision records
```

## License and attribution

Riffle is AGPL-3.0-or-later. If you run a modified version as a network
service, the AGPL requires you to offer your users the source of your version.
The UI footer links to the source for this reason. See [NOTICE](NOTICE) for
third-party attribution.
