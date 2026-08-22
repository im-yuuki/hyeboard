# Hyeboard

A multi-university student dashboard for timetables, grades, exams, tuition, courses, assignments, documents, notifications, and academic lookup tools.

Hyeboard currently supports VNU-UET through StudentHub and Canvas, VNU through `daotao.vnu.edu.vn`, and a Mock adapter for demos and local development. The browser talks only to Hyeboard; upstream university credentials remain behind the API boundary and are wrapped in Hyeboard's encrypted session token.

> [!WARNING]
> Hyeboard integrates with university systems that may change without notice. Capabilities are enabled only for response shapes verified against real upstream behavior. Do not treat unsupported features as missing UI work.

## How it works

```text
React web app
    │
    ▼
Hyeboard API/BFF
    │
    ├── Mock adapter
    ├── UET adapter ── StudentHub + Canvas
    └── VNU adapter ── daotao.vnu.edu.vn
```

The same API supports three deployment modes:

- **Cloudflare** — one Worker serves `/api/*` and the built React assets. Durable Objects coordinate CAPTCHA relay, VNU probe budgets, and VNU refresh authority.
- **Memory** — one self-hosted Node.js or Bun process with process-local state.
- **Distributed** — replicated self-hosted API and automation workers backed by PostgreSQL, Redis, and Browserless.

See [Architecture](docs/architecture.md) for session flow, runtime boundaries, exports, cross-lookup limits, and HA behavior.

## Repository layout

```text
apps/
  web/                 React 19 + Vite client
  worker/              Elysia API; Cloudflare and Node/Bun entry points
  automation-worker/   Node-only Browserless/Puppeteer job executor
packages/
  schemas/             Shared Zod schemas and inferred types
  core/                Envelopes, errors, encryption, logging, safe helpers
  university-adapters/ Adapter registry, upstream clients, parsers, mappers
  automation-protocol/ Encrypted automation job/event contracts
deploy/k8s/             Self-hosted distributed deployment templates
docs/                   Architecture, security, and operator runbooks
scripts/                Packaging, validation, benchmarks, bundle audit
```

## Requirements

- Node.js 22+
- pnpm 11.5.2 through Corepack
- A 32-byte-or-longer `HYEB_SESSION_SECRET`
- Docker only for HA integration tests or container builds

Enable the pinned package manager and install dependencies:

```bash
corepack enable
pnpm install
```

## Local development

Create `apps/worker/.dev.vars`:

```dotenv
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Generate a suitable secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start the Vite client and Wrangler API together:

```bash
pnpm dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787/api/*`
- Vite proxies `/api/*` to Wrangler in development.

Run one side only when debugging it:

```bash
pnpm dev:web
pnpm dev:worker
```

For the self-hosted Node/Bun runtime, copy `apps/worker/.env.example` to `apps/worker/.env`, set `HYEB_SESSION_SECRET`, then run:

```bash
pnpm dev:node
# or
pnpm dev:bun
```

Non-secret self-hosted defaults live in `apps/worker/config.json`. Environment variables override them.

## Build and test

```bash
pnpm build             # web, Worker typecheck, self-hosted Node bundle
pnpm test              # workspace unit/type tests + lifecycle tests
pnpm test:browser      # Playwright against fresh Wrangler and Vite servers
pnpm test:k8s          # validate Kubernetes manifests
pnpm audit:performance # build web and report entry/PDF bundle sizes
```

Target a workspace while iterating:

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/worker test:workers
pnpm --filter @hyeboard/university-adapters test
```

PostgreSQL and Redis integration suites are opt-in and require Docker:

```bash
pnpm test:ha
```

A change is not complete until its focused checks pass. User-visible frontend changes should also pass the relevant Playwright specs. Before release, use the full `pnpm build`, `pnpm test`, and `pnpm test:browser` gate.

## Packaging and deployment

### Cloudflare

Frontend source changes must be built before deployment:

```bash
pnpm build:web
pnpm deploy
```

`pnpm deploy` does not rebuild `apps/web/dist`; deploying without the build can publish stale assets.

Validate Worker packaging without publishing:

```bash
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

### Self-hosted

Create a production bundle under `dist/`:

```bash
pnpm package
```

Run it with:

```bash
cd dist
npm install --omit=dev
HYEB_SESSION_SECRET=replace-with-a-real-secret node dist/index.js
```

Container and Kubernetes deployment details live in the [HA runbook](docs/ha-runbook.md). The manifests assume external PostgreSQL, Redis, and Browserless services.

## Adding a university

1. Implement `UniversityAdapter` in `packages/university-adapters/src/`.
2. Register it in `packages/university-adapters/src/registry.ts`.
3. Add verified upstream parsers/mappers and focused tests.
4. Set each advertised capability truthfully.

Never return fabricated placeholder data for an unverified feature. Keep the capability `false` and return `UNSUPPORTED_FEATURE` until the upstream contract is understood.

## Security

- Never commit `.env`, `.dev.vars`, raw HAR captures, cookies, tokens, SAML payloads, reconnect grants, or PII.
- The frontend must never receive raw upstream credentials.
- Treat university responses as untrusted input and validate at the adapter/API boundary.
- Raw HAR files may exist locally during protocol investigation; follow [HAR Security](docs/har-security.md) before opening or processing them.

If you discover a vulnerability, do not publish credentials, captures, or student data in a public issue.

## Documentation

- [Architecture](docs/architecture.md) — runtime modes, session model, adapters, lookup and automation boundaries
- [HA runbook](docs/ha-runbook.md) — distributed configuration, health checks, session cutover, Kubernetes operations
- [HAR Security](docs/har-security.md) — credential and capture handling rules
- [Automation worker](apps/automation-worker/README.md) — worker integration and encrypted message contracts
- [Agent guide](AGENTS.md) — repository-specific instructions for coding agents

## Status

- UET, VNU, and Mock adapters are registered.
- StudentHub and Canvas credentials are independent; Canvas-only features may be unavailable in an otherwise valid UET session.
- Cloudflare, self-hosted memory, and distributed HA foundations are implemented.
- Distributed Browserless/UET automated login has not passed its full real-provider gate. Keep `AUTOMATION_EXECUTOR_READY` disabled until deployment-specific validation succeeds.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
