# Hyeboard Architecture

Hyeboard uses one Cloudflare Worker deployment containing the client-heavy dashboard and its API/BFF.

```txt
Cloudflare Worker
  ├─ static React assets (apps/web/dist)
  └─ /api/* BFF
       -> university adapter registry
       -> UET adapter
       -> StudentHub + Canvas upstream APIs
```

The frontend never calls university upstream systems directly. University-specific behavior lives in adapters.

## UET Sources

- StudentHub (`studenthub.uet.edu.vn`): profile, timetable, terms, grades, GPA, bills, exams, notifications, news, training points, service requests.
- Canvas (`portal.uet.vnu.edu.vn`): courses, planner items, assignments/quizzes/announcements, missing submissions, unread conversations, optional files.

## Session Model

University upstream origins make browser-managed third-party cookies fragile. Hyeboard therefore uses an encrypted Bearer token:

1. API receives or discovers upstream credentials.
2. API encrypts them with AES-GCM using `HYEB_SESSION_SECRET`.
3. Web stores the opaque token and sends `Authorization: Bearer <token>`.
4. API decrypts per request and replays credentials upstream.

No upstream cookies, tokens, SAML payloads, or personal data are logged.

## Academic Summaries and Exports

`apps/web/src/lib/term-academic-summary.ts` is the single pure definition of listed credits, included credits, derived term GPA, and running CPA. Grades and cross-transcript views normalize their rows into it. Portal-reported cumulative values stay separate; derived values never claim university authority.

`apps/web/src/lib/data-export.ts` builds versioned allowlisted documents from already-sanitized browser state. JSON preserves structure and calculator precision. CSV uses fixed machine columns, UTF-8 BOM, CRLF, deterministic order, formula defense, and text-safe identifiers. Downloads use temporary object URLs and always revoke them. No export path contacts an API or writes browser/server persistence.

## VNU Cross-Lookup Boundary

The code-to-ID resolver probes only the arithmetic projection and its closed ±16 neighborhood. It verifies exact eight-digit header equality, uses bounded projection-local concurrency, and cancels siblings after a deterministic winner or fatal failure. It never performs a wide/cohort search or returns an approximation.

Every route or accepted bulk chunk reserves its conservative Brc1 allowance once through the per-session Durable Object before upstream work. Candidate probes consume only that local allowance. Direct routes reserve 1 unit, code-to-ID reserves 33, and code-to-transcript reserves 34. Browser bulk runs use optional `/api/universities` limit metadata, but fixed Worker chunk validation and Durable Object enforcement remain the security boundary.

## VNU Automatic Relogin

VNU access tokens and reconnect grants are separate AES-GCM protocols. Grant keys use an HKDF context distinct from access-token encryption. Grants contain the VNU credentials needed for one tab's reconnect flow; access tokens do not.

`VnuRefreshControlDurableObject` is addressed by an HMAC-derived normalized-username principal. It stores random access-token IDs, grant IDs, expiry, a two-minute lease, and a five-attempt/fifteen-minute window—never credentials, raw tokens, or student identity. The encrypted access descriptor carries the opaque principal, exact linked IDs, and both expiries, so logout can atomically revoke its exact active pair even when a new tab has no browser grant. Logout validates any optional grant completely before its sole authoritative revoke call. A fully expired authenticated descriptor remains an idempotent access-only removal proof after authority cleanup, while any live-half mismatch fails closed. Every authority transition reports changed/no-op; no-op operations write neither state nor alarms. Active ordinary checks read authority without rewriting state or alarms; stale cleanup enters a transaction once. Refresh cryptographically decodes the outer access token through a refresh-only path, rejects principal/link mismatches without mutation, checks authority, performs one live login, verifies the live profile, and atomically revokes the old pair while activating the new pair before returning. Ordinary descriptor-bearing session resolution also checks this authority and fails closed when unavailable.

The browser coordinates one refresh per local account and failed access token. It replays only explicit side-effect-free VNU reads once. Bulk and charged cross-lookups may refresh but require a manual retry; acknowledged browser results and exports remain intact.
