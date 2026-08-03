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

Local dev env, `apps/worker/.dev.vars` (gitignored): `HYEB_SESSION_SECRET` is required. Remaining values are optional; defaults shown.

```txt
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VNU_CODE_LOOKUP_CONCURRENCY=16
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS=500
VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS=32
VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY=3
VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS=60000
```

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

VNU cross lookup requires the Cloudflare `VNU_PROBE_BUDGET` Durable Object. Self-hosted Node/Bun deployments fail cross lookup closed and omit runtime limit metadata. The browser hides bulk when metadata is missing or zero, enforces the published whole-run maximum, and sends sequential chunks of three code targets or the server-published direct-ID maximum (legacy metadata falls back to five). The Worker atomically reserves 1 unit for direct lookups and 33 per code target before Brc1 work. Code targets may run concurrently, but their combined Brc1 fetches never exceed six; a 60-second request deadline cancels pending work.

Exports are explicit browser-only JSON or CSV downloads built from sanitized result models. They do not refetch, persist, or send result content to the server. Derived term GPA/CPA values exclude missing grades and remain labeled separately from portal-reported cumulative values.

## Security

Raw HAR captures and any file containing real credentials/cookies/tokens must never be committed — `.gitignore` excludes `*.har`, `cred.txt`, `.env*`, and `.dev.vars`. See `docs/har-security.md` for HAR-handling guidance.

### VNU reconnect grants

Successful VNU sign-in returns an ordinary access token and a separate encrypted reconnect grant. The browser stores the grant only in the current tab's `sessionStorage`, keyed by Hyeboard's opaque local account ID. A new tab or browser restart requires manual VNU sign-in after upstream expiry.

Reconnect grants have a fixed eight-hour lifetime from manual sign-in. Rotation does not extend that lifetime. Cloudflare deployments serialize refresh attempts plus linked access/grant activation and revocation through `VNU_REFRESH_CONTROL`. Self-hosted Node/Bun deployments have no equivalent durable authority: they issue no reconnect grant or linked descriptor, provide no automatic refresh, and retain existing access-session behavior without claiming exact revocation.

## License

Hyeboard is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
