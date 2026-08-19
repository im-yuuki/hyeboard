# Hyeboard

Multi-university student dashboard. VNU-UET (StudentHub + Canvas) first, with a Mock adapter for demo/dev use, built as a pnpm monorepo.

## Structure

- `apps/web` — React 19, Vite, TanStack Router/Query, Tailwind CSS v4, local shadcn-style UI primitives.
- `apps/worker` — Elysia API/BFF. Deploys as a Cloudflare Worker (serving the built web app as static assets) or self-hosts on plain Node.js/Bun.
- `packages/schemas` — shared Zod schemas + inferred TypeScript types.
- `packages/core` — Worker-safe helpers: API response envelopes, `HyeboardError`, AES-GCM encrypted session token helpers.
- `packages/university-adapters` — the `UniversityAdapter` interface and registry (`mock`, `uet`). All university-specific integration logic (StudentHub/Canvas clients, response mapping, Google-login automation) lives here.

## Development

```bash
pnpm install
pnpm dev          # runs web (Vite, :5173) + worker (wrangler dev, :8787) together
```

Local dev env, `apps/worker/.dev.vars` (gitignored): `HYEB_SESSION_SECRET` is required. Remaining values are optional; defaults shown. Self-hosted HA settings are documented in [the HA runbook](docs/ha-runbook.md).

```txt
HYEB_SESSION_SECRET=
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VNU_CODE_LOOKUP_CONCURRENCY=16
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS=500
VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS=32
VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY=3
VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS=60000
# Self-hosted mode defaults to memory. Use distributed only with both shared
# dependencies configured; see docs/ha-runbook.md.
HYEB_HA_MODE=memory
# HYEB_HA_NODE_ID=api-a
# HYEB_HA_SESSION_EPOCH=0
# HYEB_HA_ENFORCE_SESSION_EPOCH=false
# HYEB_POSTGRES_URL=
# HYEB_REDIS_URL=
# HYEB_SHUTDOWN_TIMEOUT_MS=10000
```

Generate a session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Never put the generated value, database credentials, Redis credentials, or Browserless tokens in checked-in files.

Optional, `apps/web/.env.local`:

```txt
VITE_API_BASE_URL=http://localhost:8787
```

## Building & testing

```bash
pnpm build        # builds web (Vite) + typechecks the worker
pnpm test         # typecheck + vitest across every package
pnpm --filter @hyeboard/web exec playwright test   # e2e (spins up worker + web itself)
```

## HA runtime modes

The worker has three explicit runtime modes:

- `memory` — the default for self-hosted Node/Bun. Cache, revocation fallback, CAPTCHA relay, and other process-local state stay in one process. This is compatible with the existing single-worker deployment and is not a multi-replica authority.
- `distributed` — self-hosted Node/Bun with PostgreSQL and Redis configured. PostgreSQL is authoritative for VNU refresh/grant state and generic session revocation. Redis backs the shared cache, CAPTCHA relay, VNU probe budgets/permits, and related distributed primitives. The Redis single-flight/lock and refresh-coordination implementations also exist as standalone primitives; not every primitive is wired into the API yet. Missing dependencies leave readiness degraded and required operations fail closed; the process does not silently downgrade to memory authority.
- `cloudflare` — the Cloudflare Worker entry point. Durable Objects remain authoritative for the existing Cloudflare CAPTCHA, VNU probe-budget, and VNU refresh-control implementations; `config.json` is not used by this entry point.

`apps/worker/config.json` contains non-secret self-hosted defaults. Environment variables override it. Distributed mode requires `HYEB_HA_MODE=distributed`, one of `HYEB_POSTGRES_URL`/`DATABASE_URL`, and one of `HYEB_REDIS_URL`/`REDIS_URL` for ready operation. `HYEB_SESSION_SECRET` remains environment-only and must be at least 32 characters.

## Session cutover

Distributed sessions carry an opaque session ID and `sessionEpoch`. Epoch enforcement is opt-in so an operator can deploy the foundation without changing existing sessions. For the one-time cutover, choose a new shared `HYEB_HA_SESSION_EPOCH`, set `HYEB_HA_ENFORCE_SESSION_EPOCH=true` on every API replica, and keep `HYEB_SESSION_SECRET` unchanged. Tokens without distributed session metadata or with an older epoch are rejected as `SESSION_EXPIRED`; users must log in again. Do not rotate the session secret as part of this cutover.

## Deployment

Two supported targets:

**Cloudflare Workers** (single Worker serving the API + the built web app as static assets):

```bash
pnpm build:web     # required immediately before every deployment
pnpm deploy        # uploads the Worker and the current apps/web/dist assets
```

`pnpm deploy` does not rebuild the frontend. Always run `pnpm build:web` immediately before it; otherwise Wrangler can upload a stale `apps/web/dist` while deploying the single Worker.

**Self-hosted (Node.js/Bun)** — produces a standalone `dist/` directory with the bundled worker, the built web app, and a runtime `config.json`:

```bash
pnpm package        # builds + assembles dist/
cd dist
npm install --omit=dev
cp .env.example .env   # fill in HYEB_SESSION_SECRET
node dist/index.js      # or: bun run dist/index.js
```

Non-secret runtime configuration lives in `dist/config.json`; environment variables override matching file values. VNU resolver settings use `vnu.code_lookup_concurrency`, `vnu.cross_lookup_bulk_max_targets`, `vnu.cross_lookup_direct_chunk_max_targets`, `vnu.code_lookup_bulk_target_concurrency`, and `vnu.cross_lookup_request_timeout_ms` in JSON, or matching `VNU_*` environment variables. Direct chunks default to 32 and accept 1–300; bulk code target concurrency defaults to 3 and falls back to 1 when malformed; bulk requests default to 60 seconds. The whole-run bulk maximum remains independent.

For distributed self-hosting, start one API process per replica with the same session secret, HA epoch, PostgreSQL URL, and Redis URL, but a distinct `HYEB_HA_NODE_ID`. The startup path runs PostgreSQL migrations, installs shared coordinators, and exposes readiness only after configured dependencies are ready. See [docs/ha-runbook.md](docs/ha-runbook.md) for the operational sequence.

VNU cross lookup requires an authoritative probe-budget coordinator: Cloudflare uses the `VNU_PROBE_BUDGET` Durable Object, while distributed self-hosted mode uses Redis. Memory-mode self-hosted Node/Bun deployments fail cross lookup closed and omit runtime limit metadata. The browser hides bulk when metadata is missing or zero, enforces the published whole-run maximum, and sends sequential chunks of three code targets or the server-published direct-ID maximum (legacy metadata falls back to five). The Worker atomically reserves 1 unit for direct lookups and 33 per code target before Brc1 work. Code targets may run concurrently, but their combined Brc1 fetches never exceed six; a 60-second request deadline cancels pending work.

Exports are explicit browser-only JSON or CSV downloads built from sanitized result models. They do not refetch, persist, or send result content to the server. Derived term GPA/CPA values exclude missing grades and remain labeled separately from portal-reported cumulative values.

## Security

Raw HAR captures and any file containing real credentials/cookies/tokens must never be committed — `.gitignore` excludes `*.har`, `cred.txt`, `.env*`, and `.dev.vars`. See `docs/har-security.md` for HAR-handling guidance.

### VNU reconnect grants

Successful VNU sign-in returns an ordinary access token and a separate encrypted reconnect grant. The browser stores the grant only in the current tab's `sessionStorage`, keyed by Hyeboard's opaque local account ID. A new tab or browser restart requires manual VNU sign-in after upstream expiry.

Reconnect grants have a fixed eight-hour lifetime from manual sign-in. Rotation does not extend that lifetime. Cloudflare deployments serialize refresh attempts plus linked access/grant activation and revocation through `VNU_REFRESH_CONTROL`. Memory-mode self-hosted Node/Bun deployments have no equivalent durable authority: they issue no reconnect grant or linked descriptor, provide no automatic refresh, and retain existing access-session behavior without claiming exact revocation. Distributed self-hosted mode adds PostgreSQL-backed refresh/grant authority and generic revocation; it does not change the Cloudflare-specific Durable Object behavior.

## Deferred deployment work

`/api/health` is the legacy health contract. `/api/live` reports process liveness and stays useful while a shared dependency is unavailable. `/api/ready` reports dependency-backed readiness and returns `503` until the configured distributed dependencies are ready, or while the process is starting, draining, or stopped. `SIGINT` and `SIGTERM` perform an idempotent drain, stop the HTTP server, close cached browsers, Redis, and PostgreSQL within the configured shutdown budget, and then exit.

Patchright is local/single-worker only. Both the API startup path and the automation-worker configuration reject Patchright when distributed mode is enabled; distributed browser ownership must use Browserless/Puppeteer.

The encrypted automation protocol, Redis Streams worker, leases/fencing, reclaim, cancellation, graceful drain, Browserless provider, and the distributed API enqueue/event/CAPTCHA protocol are implemented. The final host bridge that supplies a real UET executor and an already-open Browserless connection is still pending; `AUTOMATION_EXECUTOR_READY` must not be enabled until that bridge is deployed. Therefore distributed Google/browser automation is not yet feature-complete and returns an explicit backend-unconfigured error rather than silently using process-local browser state. Kubernetes manifests remain deferred until the multi-replica and failure-injection gates pass. Details and opt-in Testcontainers commands are in [docs/ha-runbook.md](docs/ha-runbook.md).

## License

Hyeboard is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
