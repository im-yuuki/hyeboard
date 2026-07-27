# VNU Upstream Session Expiry Recovery Design

Status: approved
Date: 2026-07-27

## Problem and evidence

The VNU import cache validates its encrypted seed and metadata but does not validate the cached daotao ASP session. A seed can therefore remain nominally unexpired after its upstream cookie has expired. A cache hit then mints a fresh Hyeboard token around that dead upstream session.

A sanitized capture confirmed this sequence: import returned HTTP 200 from cache, then every VNU raw request received HTTP 200 containing the portal's standalone session-ended notice. `hasLoginForm()` did not recognize that page, so the frontend parsed it as empty data. This design contains no capture contents, credentials, cookies, tokens, or personal data.

## Goals

- Validate a cached daotao session against one lightweight profile request before reporting import success.
- Reuse the cached session only when the upstream profile is authenticated and matches the cached identity.
- Recover automatically through a real login when the cached upstream session is definitively expired.
- Detect login redirects, both known login-form markup variants, and the known standalone session-ended notice.
- Return `VNU_SESSION_EXPIRED` when a previously working VNU session expires during normal API use.
- Clear frontend VNU session state only for genuine session expiry, not unrelated VNU failures.

## Non-goals

- No outward route, request, response, token, or error-envelope shape change.
- No broad authentication, cache, parser, or account-management refactor.
- No change to VNU session duration, unsupported capabilities, cross-lookup policy, or raw-cache TTLs.
- No retry loop, background validation, proactive raw-cache eviction, or generic portal-content classifier.

## Expired-response detector

Keep expiry classification in the VNU adapter package as one exported, independently testable detector. Its input is the final response URL and response HTML. `DaotaoClient.fetchPage()` applies it after successful HTTP status handling and before returning HTML to any caller.

The detector returns true only for these allow-listed signals:

1. **Final login URL:** after `redirect: "follow"`, `response.url` resolves to the trusted daotao origin's login endpoint. Query strings and URL casing must not affect the path comparison. A login-looking URL on another origin is not accepted as evidence.
2. **Login form:** HTML contains the portal login form's paired username and password controls. Detection is case-insensitive and independent of attribute order, whitespace, quote style, and extra attributes, covering both known markup variants. Requiring the credential-control pair prevents an unrelated mention of one field name from matching.
3. **Standalone session-ended notice:** HTML matches the sanitized known notice fixture using its specific standalone notice structure and allow-listed normalized full notice text. Matching must tolerate insignificant tags, entities, and whitespace but must require the complete portal-specific signature.

Do not classify expiry from HTTP 200 alone, an empty parse result, a generic word such as “session” or “login,” a single form field, or arbitrary alert/red-font content. Normal authenticated pages and unrelated portal notices must remain non-matches.

When matched, `DaotaoClient` throws `HyeboardError("VNU_SESSION_EXPIRED", ..., 401)`. Existing 429, 5xx, network, and other HTTP mappings remain unchanged and take precedence over body classification.

## Import cache flow

### Cache restoration

Retain the credential-derived HMAC key and encrypted-seed cache format from the cached-session-token design. Refactor restoration to return the validated decrypted `EncryptedSessionPayload` and matching response metadata to the VNU import branch; it must not mint an outward token yet.

Cryptographic failure, payload expiry, malformed VNU credential data, or metadata inconsistency remains a cache miss. The request proceeds directly to the existing fresh-login path.

### Cache-hit validation

For a structurally valid cache hit:

1. Construct `DaotaoClient` from the decrypted cached session.
2. Call `getProfileHtml()` directly, bypassing `vnuRawHtml()` and its raw cache. This request is the required live upstream validation.
3. Parse the profile and require its student code to be present and equal to both the decrypted session identity and cached response metadata.
4. On a match, encrypt the unchanged cached payload with a fresh IV and return the existing success payload. Preserve the original `expiresAt`; do not refresh the upstream or Hyeboard lifetime.

A missing or mismatched live identity makes the entry unusable and follows the fresh-login path. This is recovery from stale or inconsistent cache state, not a credential error.

### Definitive expiry recovery

Catch only `VNU_SESSION_EXPIRED` from cache-hit profile validation as automatic recovery:

1. Invoke the existing VNU adapter import with the credentials submitted on the current request.
2. Require the normal login flow to fetch and verify the authenticated profile.
3. Normalize the verified student identity into the new session.
4. Replace the same cache entry with a new encrypted seed and matching metadata, using the new session's remaining lifetime.
5. Independently encrypt and return a fresh outward token in the unchanged response shape.

The old entry is overwritten only after fresh login and profile verification succeed. Failed recovery leaves it untouched.

### Failure classification

Cache-hit validation errors other than definitive session expiry propagate unchanged. In particular, 429, upstream 5xx, and network failures must not trigger a login, alter the cache, become `INVALID_VNU_CREDENTIAL`, or be presented as bad credentials. The same existing error mapping applies if the subsequent fresh-login attempt fails.

This produces the following decisions:

| Cache/profile result | Action |
| --- | --- |
| Missing, malformed, expired seed, or metadata mismatch | Fresh login; replace cache after verified success |
| Live profile identity matches | Mint fresh outward token; no fresh login or cache rewrite |
| Live profile reports `VNU_SESSION_EXPIRED` | Fresh login; replace cache after verified success |
| Live profile identity missing or mismatched | Fresh login; replace cache after verified success |
| Live profile returns 429, 5xx, network, or other non-expiry error | Propagate unchanged; no fresh login or cache mutation |

## Runtime expiry and raw cache

Every `DaotaoClient.fetchPage()` call uses the same detector. If an authenticated raw request is redirected to login or receives a recognized login/notice body, the client throws before returning HTML. The worker therefore emits the existing error envelope with code `VNU_SESSION_EXPIRED` and HTTP 401 instead of returning `{ html }` containing the notice.

`vnuRawHtml()` writes only HTML returned successfully by the client, so recognized expiry HTML never reaches `cachePut`. Existing raw caching remains best-effort: already cached valid data may live until its current TTL, and no new eviction mechanism is added. A successful fresh login carries a different cookie and therefore derives different raw-cache keys.

## Frontend behavior

Add `VNU_SESSION_EXPIRED` to the explicit session-death code set in `apps/web/src/lib/api.ts`. On that code, the existing request failure path removes the current VNU account/session and emits the existing session-cleared navigation behavior, taking the user to login when no replacement account is active.

Do not remove the existing tab-scoped VNU relogin credentials; they remain available to the login screen under current behavior. Do not clear or redirect for `VNU_RATE_LIMITED`, `VNU_UPSTREAM_UNAVAILABLE`, `VNU_REQUEST_FAILED`, cross-lookup errors, parser empty states, or any other VNU feature/upstream error.

## Security and privacy

- Keep usernames and passwords confined to the current import request and the existing HMAC cache-key derivation.
- Keep ASP cookies only inside the encrypted session seed and outward Hyeboard token.
- Never log or expose credentials, cookies, decrypted sessions, cache values, response HTML, capture data, or profile identity.
- Use only synthetic, non-personal fixtures in tests. The standalone notice fixture may preserve non-sensitive portal structure and text but no headers, cookies, tokens, or student data.
- Continue using existing `encryptSession`; do not introduce new cryptography or deterministic outward tokens.

## Tests

### VNU detector and client

Add focused unit tests for:

1. A followed redirect whose final trusted URL is the login endpoint.
2. Both known login-form markup variants, including changed attribute order, casing, whitespace, and quote style.
3. The sanitized standalone session-ended notice fixture.
4. Normal authenticated HTML and unrelated notices that must not match.
5. A recognized HTTP 200 expiry body producing `VNU_SESSION_EXPIRED` rather than returned HTML.
6. Existing 429, 5xx, network, and non-expiry HTTP failures retaining their current codes and statuses.

### Worker import and raw routes

Extend `apps/worker/src/app.test.ts` with synthetic scenarios covering:

1. **Observed regression:** a nominally fresh encrypted seed contains an expired ASP session; live profile validation returns HTTP 200 with the standalone notice; import performs one fresh login, repairs the cache, and returns a valid fresh token.
2. **Valid cache hit:** one live profile validation succeeds with matching identity; no adapter import occurs; the returned token is newly encrypted and retains the cached expiry.
3. **Transient validation failure:** 429, 5xx, and network errors propagate unchanged; adapter import is not called and the cache entry is unchanged.
4. **Identity mismatch:** malformed metadata remains a cache miss; a valid seed whose live profile has a missing or different identity also performs verified fresh login and replaces the cache.
5. **Recovery failure:** an expiry-triggered fresh login error propagates under its original code; the old cache entry is not rewritten.
6. **Runtime expiry:** a raw VNU request returns `VNU_SESSION_EXPIRED`; expiry HTML is absent from the API response and is not inserted into the raw cache.
7. **Fresh-cookie isolation:** repaired login uses a different raw-cache key from the expired cookie.

Retain prior cached-token assertions: seed/outward token inequality, fresh encryption on successful cache hits, unchanged cached expiry, exact-token revocation, and unchanged JSON success shape.

### Frontend

Add API-layer regression tests proving:

1. `VNU_SESSION_EXPIRED` is a session-death code, removes the active VNU account/session, and triggers existing login navigation behavior.
2. Tab-scoped VNU relogin credentials remain intact.
3. Representative unrelated VNU 401/429/5xx and feature errors do not clear account/session state or redirect.

## Verification

Run from repository root after implementation:

```bash
pnpm --filter @hyeboard/worker test
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Acceptance requires the exact HTTP 200 notice-page regression to recover on import, runtime expiry to surface `VNU_SESSION_EXPIRED`, transient errors to preserve cache and error identity, frontend clearing to remain code-specific, all existing outward API shapes to remain unchanged, and every command above to pass.
