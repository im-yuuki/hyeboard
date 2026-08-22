# Agent Development Guide

Repository-specific instructions for coding agents working on Hyeboard. User instructions override this file. Prefer the smallest correct change; do not preserve or introduce complexity without evidence.

## Product invariants

Hyeboard is a multi-university dashboard. The browser talks to Hyeboard's API, never directly to StudentHub, Canvas, or VNU. University-specific behavior belongs in adapters.

Never compromise these rules:

1. **Credentials stay behind the API boundary.** The browser receives Hyeboard's opaque encrypted Bearer token, not raw upstream cookies, tokens, passwords, SAML payloads, or reconnect grants.
2. **Capabilities are evidence-backed.** A `University.capabilities.*` flag is `true` only when the adapter implements a verified upstream shape. Unsupported features fail explicitly; never fabricate data.
3. **Session errors are scoped.** Only `MISSING_SESSION`, `SESSION_EXPIRED`, and `INVALID_SESSION` kill a Hyeboard session. Feature-specific errors such as `CANVAS_LOGIN_REQUIRED` render inline and must not sign the user out.
4. **Runtime modes fail honestly.** Distributed mode requires PostgreSQL and Redis and must not silently fall back to process-local authority. Cloudflare-only bindings stay out of Node/Bun paths; Node-only imports stay out of the Worker bundle.
5. **Every visible collection has loading, error, and empty states.** Never render raw JSON as feature UI.

## Repository map

- `apps/web` — React 19, Vite, code-based TanStack Router, TanStack Query, Tailwind CSS v4, local UI primitives.
  - Entry: `src/main.tsx`
  - Route tree: `src/router.tsx`
  - Global state/query ownership: `src/state.tsx`
  - Pages: `src/pages/*.tsx`, loaded lazily from the router
  - Shared UI: `src/components/`
  - Browser API/session logic: `src/lib/api.ts`
  - Translations: `src/lib/i18n.tsx`
- `apps/worker` — Elysia API and BFF.
  - Shared routes/runtime: `src/app.ts`
  - Cloudflare entry: `src/index.ts`
  - Node/Bun entry: `src/index.node.ts`, `src/start.ts`
  - Durable Object and HA coordination live beside their focused tests.
- `apps/automation-worker` — Node-only Redis Streams and Browserless/Puppeteer executor.
- `packages/schemas` — shared Zod schemas and inferred TypeScript types.
- `packages/core` — envelopes, `HyeboardError`, AES-GCM session/grant helpers, logging, Worker-safe helpers.
- `packages/university-adapters` — `UniversityAdapter`, registry, upstream clients, parsers, mappers. Registered adapters: `mock`, `uet`, `vnu`.
- `packages/automation-protocol` — encrypted automation jobs, events, results, and keyring contracts.
- `deploy/k8s` — distributed deployment templates; external PostgreSQL, Redis, Browserless assumed.
- `docs` — durable architecture/security/runbooks. Do not store temporary plans or investigation notes here.

## Commands

Run commands from the repository root. Use `pnpm` directly; do not wrap `pnpm` or Wrangler in PowerShell jobs/process wrappers because they hide or distort long-running output.

```bash
pnpm install
pnpm dev                         # Vite :5173 + Wrangler :8787
pnpm dev:web
pnpm dev:worker
pnpm dev:node                    # self-hosted Node API + Vite
pnpm dev:bun                     # self-hosted Bun API + Vite

pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/worker test:workers
pnpm --filter @hyeboard/university-adapters test

pnpm build
pnpm test
pnpm test:browser
pnpm test:k8s
pnpm test:ha                     # opt-in; Docker required
pnpm audit:performance
```

`lint` and `typecheck` are TypeScript checks; there is no separate repository-wide lint implementation. Use focused tests during iteration. Before release or a completion claim, run the checks appropriate to the full changed surface.

### Dev-server safety

- `apps/worker`'s `dev` script must keep `--show-interactive-dev-session=false --log-level info`.
- Playwright starts fresh Wrangler and Vite servers with `reuseExistingServer: false`.
- Do not kill processes by name or pattern. If a port is occupied, identify and confirm the exact owner before stopping it.
- Stop only servers you started.

### Deployment safety

`pnpm deploy` uploads the existing `apps/web/dist`; it does not build the frontend. When web source changed:

```bash
pnpm build:web
pnpm deploy
```

Use `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run` for Cloudflare packaging validation without publishing.

## Change workflow

1. Read the files and tests that own the behavior. Trace callers before fixing a shared function.
2. Check `git status --short`. Preserve unrelated user/agent changes.
3. Make the smallest coherent change. Reuse existing helpers, schemas, and patterns.
4. Add or update the smallest regression test that would fail without the fix.
5. Run focused diagnostics/tests, then the broader gate required by the changed surface.
6. Check `git diff --check` and review the exact diff before reporting completion.

Do not create commits, branches, issues, pull requests, or deployments unless the user asks. Do not amend, force-push, or rewrite history unless explicitly instructed.

## Testing matrix

- Web logic/component change: `pnpm --filter @hyeboard/web test`
- Worker/API change: `pnpm --filter @hyeboard/worker test`
- Cloudflare Durable Object change: include `pnpm --filter @hyeboard/worker test:workers`
- Adapter/parser/mapper change: `pnpm --filter @hyeboard/university-adapters test`
- Browser-visible flow or DOM/ARIA change: run the relevant `apps/web/tests/*.spec.ts`; use `pnpm test:browser` for the release gate
- Packaging/config change: `pnpm build`, package tests, and appropriate dry-run
- Kubernetes change: `pnpm test:k8s`
- Distributed PostgreSQL/Redis behavior: `pnpm test:ha` when Docker is available
- Performance change: measure before and after; `pnpm audit:performance` for web bundle work

A green typecheck alone is not completion evidence.

## Web conventions

### Data and state

- TanStack Query owns server state. Query keys include the feature and active university/session scope.
- `useFeatureQuery`/`FeatureFrame` are the default feature-page path.
- Keep static queries such as universities cached; do not globally invalidate every query without a verified reason.
- Account switch and refresh logic must not display data from the previous account.
- Only clear local session state for genuine session-death codes.

### Internationalization

`apps/web/src/lib/i18n.tsx` is the source of truth:

- Locales: `en`, `vi`
- Translation access: typed object tree, e.g. `t.nav.dashboard`; never `t("nav.dashboard")`
- Add every app-authored user-facing string to both dictionaries.
- Backend enum/data values remain untranslated unless the product explicitly maps them.
- Locale flags use the existing inline SVG `FlagIcon`, not emoji.
- `formatCurrency` intentionally uses VND/`vi-VN`. Do not change currency formatting merely because UI locale changes.

### UI and accessibility

- Use local primitives under `apps/web/src/components/ui`; do not run the shadcn CLI.
- Preserve keyboard operation, visible focus, semantic controls, labels, and 44px touch targets where practical.
- Keep explicit empty states for lists and grids.
- Prefer flat list rows inside one bordered section. Avoid cards inside cards.
- No gradient text, glassmorphism, glow hover effects, decorative sparklines, or colored side-stripe borders wider than 1px.
- Theme tokens live in `apps/web/src/styles.css`. Preserve light, dark, UET/VNU palettes, and the pre-JS theme fallback.
- User-customized hue writes `--primary`, `--accent`, `--ring`, and sidebar variables inline; do not remove the CSS fallback.
- Route pages are lazy-loaded. Keep heavy optional features such as PDFMake outside the initial entry graph.

## Adapter conventions

- Implement `UniversityAdapter` in `packages/university-adapters/src/types.ts`; register it in `registry.ts`.
- Validate external responses before mapping them into shared schemas.
- Keep upstream URLs, auth, retries, cancellation, and response parsing inside the adapter/client boundary. The API layer should not know university response shapes.
- Preserve `AbortSignal` through network and browser operations.
- Never log upstream response bodies, credentials, tokens, grants, cookies, CAPTCHA images, or student identifiers.
- StudentHub `sessionStart`/`sessionEnd` are period ordinals, not clock hours. Render period numbers unless a verified timetable defines clocks.
- `ClassSession.weekday` is ISO: Monday `1` through Sunday `7`.
- VNU cross-lookup limits, budgets, permits, and no-store behavior are security/abuse boundaries. Do not raise, bypass, or cache them as a performance shortcut.

## Runtime boundaries

### Cloudflare

- `apps/worker/src/index.ts` may use `cloudflare:workers`, Browser Rendering, and Durable Object bindings.
- Keep Wrangler assets under `apps/web/dist`; `/api/*` runs Worker-first.
- Load secrets from Worker secrets, never `wrangler.jsonc` vars.

### Node/Bun memory mode

- Non-secret defaults live in `apps/worker/config.json`.
- `HYEB_SESSION_SECRET` is environment-only and at least 32 characters.
- Memory mode is single-process and not replica-safe.

### Distributed mode

- PostgreSQL is durable authority for session revocation and VNU refresh/grant state.
- Redis coordinates shared cache, CAPTCHA, VNU budgets/permits, and automation streams.
- Dependency outages fail closed for affected operations; `/api/live` and `/api/ready` have distinct semantics.
- Patchright is local/single-worker only. Distributed automation uses Browserless/Puppeteer.
- `AUTOMATION_EXECUTOR_READY` is an explicit deployment gate. Do not enable it or claim parity without a successful real-provider validation.

## Secrets, HAR, and generated artifacts

Never commit or expose:

- `.env`, `.env.*` except `.env.example`, `.dev.vars`
- raw `.har` files
- cookies, auth headers, JWTs, SAML payloads, reconnect grants, passwords, CAPTCHA images
- student PII or PII-bearing response bodies
- Playwright reports/results, Wrangler state, build output, coverage, local scratch

Only manually redacted captures belong under `samples/har-redacted/`. For large HAR analysis, parse JSON programmatically and print field names/shapes only. Follow `docs/har-security.md`.

## Documentation ownership

- `README.md` — product overview, setup, common commands, deployment entry points
- `AGENTS.md` — coding-agent operating rules
- `CLAUDE.md` — reference to `AGENTS.md`; do not duplicate instructions
- `docs/architecture.md` — durable system design and invariants
- `docs/ha-runbook.md` — operator configuration and rollout procedures
- `apps/automation-worker/README.md` — worker contract and limitations

Update durable docs when architecture or operator behavior changes. Keep temporary plans, audit notes, and scratch artifacts outside tracked documentation.

## Communication

Use terse, technical updates. Report exact files, commands, failures, and residual risks. Do not claim tests, builds, deployments, or performance improvements without fresh evidence.
