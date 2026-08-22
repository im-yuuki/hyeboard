# Hyeboard

Hyeboard is a student dashboard for university services. It brings timetable, grades, exams, tuition, course, assignment, and notification data into one web application.

VNU-UET is the first supported university. The project includes StudentHub and Canvas adapters, plus a Mock adapter for local development and demos.

## Project layout

- `apps/web` contains the React frontend.
- `apps/worker` contains the API/BFF and deployment entry points for Cloudflare Workers and self-hosted Node.js/Bun.
- `apps/automation-worker` runs browser automation jobs for self-hosted deployments.
- `packages/schemas` contains shared Zod schemas and TypeScript types.
- `packages/core` contains runtime-independent API and session helpers.
- `packages/university-adapters` contains the university adapter interface, registry, upstream clients, and response mappers.
- `packages/automation-protocol` contains the encrypted job and event protocol used by the self-hosted automation worker.

## Architecture

The browser talks to Hyeboard's API. The API selects a university adapter and communicates with upstream university services. Upstream cookies and tokens stay on the server; the browser receives Hyeboard's own encrypted session token.

The application supports three runtime modes:

- **Cloudflare** uses one Worker for the API and static frontend assets. Durable Objects provide the stateful coordination required by the Cloudflare deployment.
- **Memory** runs the self-hosted API as a single Node.js or Bun process with process-local state.
- **Distributed** runs self-hosted API replicas with PostgreSQL and Redis for shared session, cache, CAPTCHA, lookup, and automation coordination.

See [`docs/architecture.md`](docs/architecture.md) for data flow, session handling, runtime boundaries, and security properties.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): system design and runtime modes.
- [`docs/ha-runbook.md`](docs/ha-runbook.md): self-hosted PostgreSQL, Redis, automation, readiness, and shutdown operations.
- [`docs/har-security.md`](docs/har-security.md): rules for handling HAR captures and credentials.
- [`apps/automation-worker/README.md`](apps/automation-worker/README.md): automation worker integration and message contracts.

Development, testing, environment variables, packaging, and deployment details belong in the runbooks and package documentation rather than this overview.

## Status

VNU-UET and Mock adapters are available. Canvas support is optional and depends on the credentials supplied for a session. Additional universities can be added by implementing `UniversityAdapter` and registering it in `packages/university-adapters`.

The self-hosted distributed runtime and encrypted automation protocol are implemented. Browser automation providers and university login flows remain deployment-specific; see the automation documentation for current limits.

## License

Hyeboard is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
