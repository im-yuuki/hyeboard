# HA Runbook

This runbook covers the implemented self-hosted HA foundation and the work that is still deferred. It does not authorize a Kubernetes deployment. Kubernetes manifests wait for the multi-replica gates in the final section.

## Modes

- `memory`: single-process Node/Bun operation. It is the safe default for local development and preserves process-local behavior; it is not replica-safe.
- `distributed`: Node/Bun API replicas share PostgreSQL and Redis. Both dependencies are required for ready operation.
- `cloudflare`: the Wrangler entry point with the existing Durable Object bindings. Use Cloudflare configuration, not this Node/Bun runbook, for that mode.

Do not use `HYEB_HA_MODE=cloudflare` to make a self-hosted process emulate Durable Objects. The Cloudflare entry point selects and installs those bindings.

## Self-Hosted Configuration

`HYEB_SESSION_SECRET` is required for every self-hosted API process and must be at least 32 characters. It is read from the environment only. Keep it, database credentials, Redis credentials, and Browserless tokens out of `config.json`, `.env.example`, logs, and source control.

For memory mode:

```txt
HYEB_SESSION_SECRET=
HYEB_HA_MODE=memory
```

For each distributed API replica, use the same values for the shared settings and a distinct node ID:

```txt
HYEB_SESSION_SECRET=
HYEB_HA_MODE=distributed
HYEB_HA_NODE_ID=api-a
HYEB_HA_SESSION_EPOCH=0
HYEB_HA_ENFORCE_SESSION_EPOCH=false
HYEB_POSTGRES_URL=
HYEB_REDIS_URL=
HYEB_SHUTDOWN_TIMEOUT_MS=10000
```

`DATABASE_URL` is accepted as an alias for `HYEB_POSTGRES_URL`; `REDIS_URL` is accepted as an alias for `HYEB_REDIS_URL`. Use one PostgreSQL URL and one Redis URL. The URLs above are intentionally blank: supply them through the deployment environment, not a checked-in file. `HYEB_HA_NODE_ID` is optional in the parser but recommended for every replica so readiness and operator diagnostics identify the process.

`apps/worker/config.json` may carry non-secret defaults. Environment variables override matching values. `HYEB_HA_MODE=distributed` without both shared URLs starts the process degraded; it does not downgrade to memory mode.

Start the self-hosted API with `pnpm dev:node`, `pnpm dev:bun`, or the packaged `node dist/index.js`/`bun run dist/index.js` entry point. The distributed entry point runs ordered PostgreSQL migrations before marking PostgreSQL-backed dependencies ready.

## Shared Storage Roles

PostgreSQL is authoritative for:

- VNU refresh/grant activation, refresh leases, tombstones, and revocation transitions.
- Generic token and session revocation, stored as domain-separated opaque hashes with expiry.
- Ordered migration state and checksums.

Redis provides in the currently wired distributed API:

- Shared cache used by the API.
- CAPTCHA relay state, answer/cancel transitions, timeout, and cross-process wakeup.
- VNU probe budgets, Brc1 permits, cross-detail permits, leases, and rate-window primitives.

The repository also contains Redis single-flight/lock and refresh-coordination primitives. They are tested building blocks, but not all are wired into the API; PostgreSQL remains the current API authority for VNU refresh state.

Redis provides automation job/event streams for the standalone automation-worker foundation.

Redis outages and PostgreSQL outages fail closed for operations that require the affected authority. They do not turn a distributed process into a memory-mode process.

## Health And Shutdown

Check all three public endpoints on every replica:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/live
curl -i http://127.0.0.1:8787/api/ready
```

Expected behavior:

- `/api/health` preserves the legacy service health response.
- `/api/live` is `200` while the process is alive, even when a dependency is unavailable; it becomes `503` after stop.
- `/api/ready` is `200` only when lifecycle state is `ready`; startup, degraded dependencies, draining, and stopped state return `503`.
- Readiness diagnostics expose only safe mode/state/dependency fields. They do not expose URLs, credentials, tokens, or probe error details.

Send `SIGTERM` for a normal stop. The API marks itself draining, stops accepting new work through the server shutdown path, closes cached browser sessions, closes Redis clients and the PostgreSQL pool, and exits once the bounded shutdown budget completes. `SIGINT` follows the same idempotent path. A timeout is recorded in the lifecycle report; it is not a license to treat an interrupted browser or stream operation as acknowledged.

## Session Epoch Cutover

The epoch is a one-time invalidation boundary for existing self-hosted sessions. Do not rotate `HYEB_SESSION_SECRET` as part of this procedure.

1. Provision PostgreSQL and Redis, run the distributed API with `HYEB_HA_ENFORCE_SESSION_EPOCH=false`, and confirm every replica reports ready.
2. Select one new non-negative epoch, set the same `HYEB_HA_SESSION_EPOCH` on every replica, and restart/roll the replicas consistently.
3. Enable `HYEB_HA_ENFORCE_SESSION_EPOCH=true` on every replica using that same epoch.
4. Confirm a legacy session is rejected with `SESSION_EXPIRED`, then sign in again to mint a session carrying the current epoch.
5. Keep the epoch and enforcement setting stable. A later intentional invalidation repeats the policy with another explicitly chosen epoch, but is a separate operational cutover.

While enforcement is disabled, old sessions remain accepted for compatibility. Once enabled, tokens without session ID/epoch metadata and tokens with a mismatched epoch require login again. This is expected behavior, not an upstream university-session failure.

## Automation Status

The standalone `apps/automation-worker` and `packages/automation-protocol` foundations currently provide:

- Encrypted job, credential, result, and event envelopes with expiry and key IDs.
- Redis Streams consumer groups, pending-message reclaim, job leases, fencing, heartbeats, retries, cancellation, and bounded shutdown drain.
- A Browserless/Puppeteer provider with reconnect metadata and no token in exposed connection metadata.

The distributed API now enqueues encrypted UET jobs, consumes validated event/result streams, and exposes signed CAPTCHA answer/cancel controls. The executable host CLI bridge in `apps/automation-worker` supplies the UET executor and Browserless/Puppeteer provider, and the UET adapter uses the worker-owned Puppeteer session with ownership checks around browser work. `AUTOMATION_EXECUTOR_READY` remains an explicit deployment gate; the bridge does not by itself establish full feature parity.

In distributed API mode, inline Google browser automation is rejected with `AUTOMATION_BACKEND_UNCONFIGURED`, and the queue backend remains unavailable unless `AUTOMATION_EXECUTOR_READY=true` is explicitly configured. The Browserless image is pinned to `ghcr.io/browserless/chromium:v2.55.4`, was pulled manually, and started successfully; a live Puppeteer CDP smoke test passed against `ws://127.0.0.1:3000/chromium`, including a token query. A real UET/Google login E2E has not run because upstream credentials are unavailable. Manual credential paths that do not need a browser remain governed by their existing adapter behavior.

Patchright is prohibited in distributed mode. The API rejects `HYEB_BROWSER_PATCHRIGHT=true` in distributed HA mode, and the automation worker rejects `AUTOMATION_EXECUTION_MODE=distributed` with `AUTOMATION_BROWSER_PROVIDER=patchright`. Patchright is available only for local/single-worker execution. Distributed automation must use Browserless/Puppeteer.

If the standalone worker is exercised before API integration, its required environment variable names are:

```txt
REDIS_URL=
BROWSERLESS_ENDPOINT=
BROWSERLESS_TOKEN=
AUTOMATION_KEY_CURRENT_ID=
AUTOMATION_KEY_CURRENT_B64=
```

`BROWSERLESS_TOKEN` and `AUTOMATION_KEY_CURRENT_B64` are intentionally blank. The Browserless endpoint must not contain a token query parameter. `AUTOMATION_KEY_PREVIOUS_ID` and `AUTOMATION_KEY_PREVIOUS_B64` are optional rotation inputs and must be supplied together. The worker has additional optional stream, lease, heartbeat, reclaim, retry, result-TTL, and shutdown settings with code defaults.

## Opt-In Integration Tests

The Testcontainers suites are intentionally opt-in and are not part of the default root test command. They require a working Docker daemon and the `postgres:16-alpine` and `redis:7-alpine` images:

```bash
docker pull postgres:16-alpine redis:7-alpine
pnpm test:ha:postgres
pnpm test:ha:redis
pnpm test:ha
```

The PostgreSQL suite checks shared session revocation, refresh serialization, outage behavior, readiness, and SIGTERM drain across two worker processes. The Redis suite checks cross-process refresh coordination, CAPTCHA relay, Redis outage behavior, readiness/liveness separation, and SIGTERM drain. If Docker or an image is unavailable, the suites report a skip rather than a fake passing integration result.

The latest live PostgreSQL and Redis HA runs passed. These results verify the shared-dependency and failure-handling foundation only; they do not verify a real Browserless login or Kubernetes deployment.

## Kubernetes Gate

Do not add or deploy Kubernetes manifests until all of these pass against the implemented runtime:

- Two API replicas work under round-robin traffic without sticky sessions.
- VNU refresh, cross-lookup authority, and generic revocation are shared and survive replica restart.
- CAPTCHA works across replicas.
- Browser jobs reclaim safely with fencing once the API queue integration exists.
- Redis and PostgreSQL outages fail closed where required.
- Readiness and graceful shutdown are verified, including browser/Redis/PostgreSQL cleanup.
- The explicit session epoch cutover policy is verified.
- Patchright cannot be enabled in distributed mode.
- `pnpm build`, `pnpm test`, Playwright, Node package checks, and the Wrangler dry-run pass.

Until this gate passes, deployment guidance is limited to Cloudflare, single-worker memory mode, and explicitly tested distributed Node/Bun processes. Kubernetes is deferred, not partially supported.
