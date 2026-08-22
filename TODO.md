# Hyeboard HA / Multi-Replica Implementation Plan

Status: approved and in progress. Kubernetes manifests now exist as a deployment template; production rollout still requires the runtime gates below.

## Decisions

- PostgreSQL is authoritative for VNU refresh/grant/revocation state and generic session revocation.
- Redis provides CAPTCHA relay, probe budgets, permits, semaphores, rate limits, single-flight locks, cache, and automation streams.
- Cloudflare keeps its existing Durable Object implementations.
- Self-hosted distributed mode uses a separate automation worker and Browserless/Puppeteer.
- Patchright is forbidden in distributed mode and remains local/single-worker only.
- Redis/PostgreSQL integration tests use Testcontainers.
- Existing self-hosted sessions are invalidated once at cutover and require login again; `HYEB_SESSION_SECRET` is not rotated.
- Kubernetes configuration starts only after multi-replica and failure-injection gates pass.

## Implementation batches

### Batch 0 — Baseline

- [x] Run and record `pnpm typecheck`, `pnpm test`, `pnpm build`, Node package checks, and Wrangler dry-run.
- [ ] Run Playwright after the repository's browser binaries are installed.
- [x] Confirm clean baseline at commit `d40ef77`.

### Batch 1 — Contracts, configuration, and session cutover

- [x] Add explicit `cloudflare`, `distributed`, and `memory` runtime modes.
- [x] Add shared contracts for cache, revocation, automation backend, readiness, and lifecycle.
- [x] Add optional session ID/epoch metadata and one-time distributed cutover validation.
- [x] Keep Cloudflare and memory mode behavior compatible.
- [x] Update `.env.example`, `config.json`, and configuration tests.

### Batch 2 — PostgreSQL authority

- [x] Add Node-only `pg` pool/runtime and ordered migrations.
- [x] Add VNU refresh authority with advisory locks, row locks, and existing pure transitions.
- [x] Add authoritative generic session revocation using HMAC-derived opaque IDs.
- [x] Add migration idempotency, concurrency, rollback, and outage test scaffolding.
- [x] Keep all PostgreSQL imports unreachable from the Cloudflare bundle.
- [x] Run live PostgreSQL integration tests with Docker/Testcontainers; latest run passed.

### Batch 3 — Redis primitives and coordinators

- [x] Add Node-only Redis clients, blocking connection, key namespace, TTL, Lua scripts, and error mapping.
- [x] Add Redis CAPTCHA relay with state hash, event stream, timeout, cancellation, and answer/cancel CAS.
- [x] Add Redis VNU probe budget, permit, semaphore, and lease coordinators.
- [x] Move shared cache and coordination primitives to Redis in distributed mode.
- [x] Preserve existing Cloudflare coordinators and public error semantics.
- [x] Run live Redis integration tests with Docker/Testcontainers; latest run passed.

### Batch 4 — Cancellation-aware adapter

- [x] Propagate `AbortSignal` through UET login and browser operations.
- [x] Ensure timeout and cancellation close pages/browser work, not merely reject a race.
- [x] Preserve Cloudflare Browser Rendering and local inline behavior.
- [x] Reject Patchright when distributed mode is enabled.

### Batch 5 — Automation protocol and worker

- [x] Add runtime-neutral encrypted automation protocol package.
- [x] Add Redis Streams job/event protocol with replay, cancellation, deadlines, retries, and fencing foundation.
- [x] Add dedicated automation worker with consumer-group reclaim and graceful drain foundation.
- [x] Add Browserless provider with reconnect endpoint, lease, and fencing foundation.
- [x] Move OCR/browser ownership out of the API process in distributed mode through the host CLI bridge and worker-owned Puppeteer session.
- [x] Wire the API UET login/refresh flow to enqueue jobs and consume events/results.
- [x] Supply the real UET executor/Browserless connection bridge through the host CLI and UET adapter.
- [ ] Make the real distributed Browserless/UET Google login pass. The run used credentials supplied through the local ignored `.env`, local PostgreSQL/Redis, the API, and the automation worker. `/api/ready` reached ready and `pnpm test:ha` passed PostgreSQL 5/5 and Redis 4/4, but login progress `0, 10, 35, 35, 60` ended with HTTP 502 `GOOGLE_SIGNIN_FAILURE`; the worker logged Puppeteer `Attempted to use detached Frame ...` while waiting for Keycloak `#username`. The pinned `ghcr.io/browserless/chromium:v2.55.4` image and CDP smoke test passed. The node-redis stream read-shape fix is committed as `f7c78fd`.

### Batch 6 — API/startup integration

- [x] Wire distributed PostgreSQL/Redis dependencies in `start.ts`/`index.node.ts` only.
- [x] Keep `index.ts` Cloudflare-only and preserve Durable Object wiring.
- [x] Integrate resumable automation SSE, job ownership, CAPTCHA answer, and cancellation protocol.
- [x] Avoid hidden downgrade from distributed authority to process-local state.

### Batch 7 — Readiness, shutdown, packaging, and local services

- [x] Add liveness, health, and dependency-backed readiness endpoints.
- [x] Implement draining shutdown for requests, SSE, leases, browsers, Redis, and PostgreSQL.
- [x] Update package/build checks and add local Redis/PostgreSQL/Browserless orchestration.
- [x] Ensure secrets never enter checked-in config or logs.

### Batch 8 — Integration tests and documentation

- [x] Add opt-in Testcontainers Redis/PostgreSQL integration suite.
- [x] Add two-process round-robin and worker crash/reclaim harness scaffolding.
- [x] Run live two-process/failure-injection tests with Docker images available; PostgreSQL and Redis HA runs passed.
- [x] Update README, architecture docs, and HA runbook.

## Parallel subagent execution

1. Foundation/contracts first; no application integration until interfaces stabilize.
2. Then run PostgreSQL, Redis, and adapter workstreams in parallel with disjoint file ownership.
3. Run protocol, Browserless, automation worker, and lifecycle workstreams in parallel.
4. Assign one owner for conflicting `app.ts`, `start.ts`, `index.node.ts`, and `index.ts` integration.
5. Run harness, web stream, docs, and bundle/security audits in parallel after integration.
6. Run targeted tests after every wave and the full gate after every integration boundary.

## Kubernetes gate

The manifests are written. Production rollout requires all of these gates:

- [ ] Two API replicas work without sticky sessions.
- [ ] Self-hosted VNU refresh and cross-lookup are authoritative and shared.
- [ ] CAPTCHA works across replicas.
- [ ] Browser jobs reclaim safely with fencing.
- [ ] Revocation survives replica restart.
- [ ] Redis/PostgreSQL outages fail closed where required.
- [ ] Readiness and graceful shutdown are verified.
- [ ] Old sessions follow the explicit cutover policy.
- [ ] Patchright cannot be enabled in distributed mode.
- [ ] `pnpm build`, `pnpm test`, `pnpm test:k8s`, Playwright, package checks, and Wrangler dry-run pass.
