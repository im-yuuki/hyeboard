# VNU Automatic Relogin Design

Status: approved
Date: 2026-07-28
Baseline: merged `master` at `7178380`

## Problem

Hyeboard currently removes a VNU account when a live daotao session returns `VNU_SESSION_EXPIRED`. Some `VNU_LOGIN_REQUIRED` responses also indicate that the access token lacks a usable VNU credential. Both conditions are recoverable with the VNU username and password supplied during manual login.

The browser currently keeps those credentials as plaintext tab-scoped relogin values. Broadly retrying every `VNU_LOGIN_REQUIRED` would also loop on profile-shape failures that a new login cannot repair.

## Goal

Recover transparently from definitive VNU session expiry and recoverable missing VNU credentials by using an encrypted, tab-scoped refresh grant. Never attempt automatic relogin for structural profile incompleteness.

## Non-goals

- No cross-tab refresh or refresh after a browser restart.
- No recovery from arbitrary `VNU_LOGIN_REQUIRED` responses.
- No automatic replay of bulk requests.
- No durable server-side credential vault or account-management service.
- No credential inside an ordinary access token.
- No changes to UET inline reauthentication, CAPTCHA handling, or UET session refresh.
- No deployment work.

## Decisions

### Recoverability classification

Automatic VNU relogin has exactly two triggers:

1. `VNU_SESSION_EXPIRED`.
2. `VNU_LOGIN_REQUIRED` whose sanitized error details are exactly `{ "reason": "MISSING_VNU_CREDENTIAL" }`.

`MISSING_VNU_CREDENTIAL` is a stable protocol value, not message text. The frontend must not infer recoverability from HTTP status, error prose, a code prefix, or missing parsed data.

Every hidden-ID or profile-shape failure currently reported as `VNU_LOGIN_REQUIRED` becomes `VNU_PROFILE_INCOMPLETE`. This includes a missing or malformed own internal student ID, internal university ID, or required student code. `VNU_PROFILE_INCOMPLETE` is nonrecoverable and remains inline. A fresh login must never be attempted for it.

The worker may return `VNU_LOGIN_REQUIRED` without a recoverability reason for other login-required conditions. Such responses are also nonrecoverable. Only the exact allow-listed pair above enters the refresh state machine.

### Chosen credential design

A successful manual VNU login returns two independent encrypted values:

- the existing access token, containing the upstream VNU session credential but no username or password;
- an eight-hour VNU refresh grant, containing the credentials and identity binding needed for relogin.

The refresh grant is recommended over both alternatives:

- **Plaintext `sessionStorage`: rejected.** Lower implementation cost, but it leaves reusable credentials directly readable by any same-origin script and becomes error-prone when several VNU accounts coexist.
- **Server credential vault: rejected.** It could support cross-tab and long-lived refresh, but introduces durable credential custody, account lookup, deletion, and breach scope beyond this feature.
- **Encrypted tab grant: chosen.** It removes plaintext browser storage, remains isolated by local account, expires quickly, and requires no server credential vault.

Embedding the password in the ordinary access token is rejected. Access tokens travel on every authenticated request and have different purpose, exposure, rotation, and revocation semantics. A purpose-bound grant limits credential-bearing material to login, refresh, and logout requests.

## Security boundaries

### Refresh grant payload

Use a distinct payload type and encrypt/decrypt functions. Do not pass the grant through `decryptSession()` or accept an access token as a grant.

```text
VnuRefreshGrantPayload {
  version: 1
  purpose: "vnu-refresh"
  grantId: cryptographically random unique identifier
  universityId: "vnu"
  username: normalized VNU username
  password: VNU password
  expectedStudentCode: verified student identity
  issuedAt: ISO timestamp
  expiresAt: ISO timestamp, exactly eight hours after issue
}
```

`grantId` needs at least 128 bits of cryptographic randomness. AES-GCM uses a fresh random IV for every grant encryption. Key derivation may reuse `HYEB_SESSION_SECRET`, but must use domain separation from access-token encryption, such as a dedicated HKDF context or derived-key label. Payload validation requires exact version, purpose, university, timestamps, nonempty credentials, grant ID shape, and expected identity.

The eight-hour lifetime is fixed at issue. Rotation preserves the original `expiresAt`; refresh does not extend the credential-retention window. A manual login starts a new eight-hour lifetime because the user has supplied the credentials again.

### Browser storage

Store the encrypted grant only in `sessionStorage`, under `hyeboard.vnu.refreshGrant.<accountId>`. The suffix is the local opaque `StoredAccount.id`, not a university or student identifier. Multiple VNU accounts therefore have separate grants.

Never place a grant in `localStorage`, TanStack Query data, query keys, URLs, exports, analytics, logs, error details, or rendered diagnostics. Never copy it between tabs. A new tab has no grant and requires manual VNU login.

After manual login succeeds and the grant is stored, delete `hyeboard.relogin.vnu.username` and `hyeboard.relogin.vnu.password`. Failed login retains only the current form state; it does not persist plaintext credentials.

### Authoritative control storage

Add a dedicated `VnuRefreshControlDurableObject`. Address it by:

```text
HMAC(server secret, "vnu-refresh-principal:" + normalized username)
```

Only the derived digest becomes the Durable Object name, rate-limit key, or log-safe correlation value. Raw usernames, passwords, student identities, access tokens, and grants never become storage keys.

This dedicated Durable Object is the explicit implementation recommendation. KV is eventually consistent and cannot atomically serialize grant rotation, revocation, and attempt limits. Extending `VnuProbeBudgetDurableObject` would couple unrelated oracle-budget and authentication lifecycles, migrations, failure modes, and storage records. A dedicated object gives each VNU login principal one authoritative serialized state machine while following the repository's existing Durable Object coordinator pattern.

The object stores no credentials. It stores only:

- active and revoked grant IDs with their expiry;
- a short refresh lease for the current grant ID;
- fixed-window refresh-attempt count and reset time.

Allow five refresh login attempts per HMAC-derived principal in 15 minutes. Count an attempt when `beginRefresh` grants a lease, before upstream login. Rejected duplicate, revoked, malformed, or coordinator-unavailable requests do not consume the limit. Retryable upstream failures still consume one attempt because they performed a credential login.

Revoked grant records remain until their grant expiry, then may be deleted by alarm or lazy cleanup. This persistence is required: process memory, Cache API, and best-effort writes are insufficient for single-use rotation. If the coordinator is unavailable, refresh fails closed with a retryable 503; it never logs in without authoritative grant-state and rate-limit checks.

Existing exact access-token revocation remains in the access-token revocation abstraction. Successful logout/removal submits both token and grant: the token is revoked until its access expiry, and the grant ID is authoritatively revoked until grant expiry.

### Secret handling

- Decrypt the grant only inside the refresh/logout request handling path.
- Pass credentials directly to the existing VNU adapter login, then release request-local references.
- Never log request bodies, grants, decrypted payloads, credentials, upstream cookies, or returned profile data.
- Log only request ID, stable code, status, operation, and HMAC-derived principal key when needed.
- Error details use an explicit allow-list: `reason`, `retryAfterSeconds`, `limit`, and `windowSeconds`. No upstream body, exception text, identity, credential fragment, grant ID, or token hash reaches the client.
- Tests use visibly synthetic non-identity placeholders. Do not use plausible student codes, usernames, internal IDs, or copied portal data.

## Wire contracts

All responses retain the existing `{ data, error, meta? }` envelope.

### Manual login

`POST /api/vnu/auth/import-session`

Request remains:

```json
{
  "vnuUsername": "<user-entered value>",
  "vnuPassword": "<user-entered value>"
}
```

Successful data becomes:

```json
{
  "token": "<opaque access token>",
  "refreshGrant": "<opaque encrypted grant>",
  "session": {
    "universityId": "vnu",
    "studentCode": "<verified identity>",
    "expiresAt": "<access expiry>",
    "authenticated": true
  }
}
```

The worker issues both values only after live VNU login and profile identity verification. A cached import may issue a grant only when its HMAC cache hit proves the exact submitted credential pair was validated previously and the required live profile check still verifies the cached identity. Issuing a grant through manual login replaces and revokes the principal's prior active grant.

### Refresh

`POST /api/vnu/auth/refresh`

Headers:

```text
Authorization: Bearer <failed access token>
Content-Type: application/json
Cache-Control: no-store
```

Request:

```json
{
  "refreshGrant": "<opaque encrypted grant>"
}
```

Successful data has the same shape as manual login: a rotated access token, rotated refresh grant, and verified session summary. The response also uses `Cache-Control: no-store`.

The worker validates, in order:

1. Request shape and access-token cryptographic validity. Upstream expiry does not make the Hyeboard token cryptographically invalid.
2. Grant cryptographic validity, version, purpose, and fixed expiry.
3. Access token and grant both represent VNU and carry the same expected student identity.
4. Authoritative grant state and refresh rate limit through the HMAC-derived Durable Object.
5. Fresh upstream login with the grant credentials.
6. Live profile identity equality with `expectedStudentCode`.
7. Rotation: mint a fresh access token and grant with a new grant ID, preserve the grant's original expiry, mark the previous grant ID revoked until expiry, then return success.

The endpoint never accepts a local browser account ID. `accountId` is not server authority; browser account binding is enforced by the client race guard.

### Logout and removal

`POST /api/vnu/auth/logout` accepts an optional encrypted grant in its JSON body while the access token remains in `Authorization`. A successful response means every supplied valid artifact has been revoked. Missing, already expired, or already revoked artifacts are idempotent success. When a decryptable grant identifies a principal, the Durable Object revokes both the supplied ID and any current or leased grant for that principal. This closes the race where an in-flight refresh rotates immediately before removal; a later `completeRefresh` against a revoked lease must also fail.

VNU logout and account removal await this response before deleting local state. A network or coordinator failure shows a retryable error and retains the unchanged account and grant, allowing the user to retry revocation. After success, clear the account's grant and any legacy plaintext VNU keys, then remove the account. Removing a nonactive VNU account uses the same flow; it must not call the active account's token or grant.

UET and mock logout contracts remain unchanged.

### Stable error contract

| Code | HTTP | Details | Client action |
| --- | ---: | --- | --- |
| `VNU_SESSION_EXPIRED` | 401 | none | Attempt refresh when grant exists |
| `VNU_LOGIN_REQUIRED` | 401 | `{ reason: "MISSING_VNU_CREDENTIAL" }` only for this condition | Attempt refresh when exact reason matches |
| `VNU_PROFILE_INCOMPLETE` | 500 | none | Inline nonrecoverable error; never refresh |
| `VNU_REFRESH_GRANT_INVALID` | 401 | none | Clear grant; remove unchanged account; manual login |
| `VNU_REFRESH_GRANT_REVOKED` | 401 | none | Clear grant; remove unchanged account; manual login |
| `INVALID_VNU_CREDENTIAL` | 401 | none | Clear grant; remove unchanged account; manual login |
| `VNU_REFRESH_IDENTITY_MISMATCH` | 409 | none | Revoke and clear grant; remove unchanged account; manual login |
| `VNU_REFRESH_RATE_LIMITED` | 429 | allow-listed retry timing only | Retain grant/account; inline retry action |
| `VNU_REFRESH_UNAVAILABLE` | 503 | optional `retryAfterSeconds` | Retain grant/account; inline retry action |
| Existing VNU 429, 5xx, or network mapping | existing | existing sanitized timing only | Retain grant/account; inline retry action |

Malformed request bodies remain normal 400 responses and do not trigger refresh. Error messages are user-safe copy selected by code. Upstream exception text and response content are never forwarded.

## Worker refresh state machine

The Durable Object serializes each principal:

```text
ACTIVE(grantId)
  -> LEASED(grantId, leaseExpiry)       begin accepted refresh
  -> ACTIVE(newGrantId)                 verified login; old ID revoked
  -> REVOKED(grantId)                   invalid credentials, mismatch, logout

LEASED(grantId)
  -> ACTIVE(grantId)                    retryable upstream failure or lease expiry
  -> ACTIVE(newGrantId)                 verified login and rotation
  -> REVOKED(grantId)                   definitive failure
```

`beginRefresh` atomically validates the grant ID, consumes one rate-limit attempt, and creates a short lease. Concurrent attempts using the same ID cannot both reach VNU login. They receive a retryable in-progress response or join at the browser layer.

Use a two-minute lease. On 429, upstream 5xx, network failure, cancellation observed before commit, or adapter timeout, release the lease and leave the same grant active. If the Worker terminates before release, lease expiry restores eligibility. On invalid credentials or identity mismatch, revoke the grant. On successful login, `completeRefresh` atomically revokes the old ID and activates the new ID before the response is returned.

If response delivery fails after `completeRefresh`, the previous grant remains revoked. The client must fall back to manual login because replaying an already-rotated credential grant cannot safely recover the lost response. This bounded failure mode preserves single-use rotation.

## Browser state machine

Maintain one module-level single-flight promise per `(accountId, failedToken)`. The failed token is captured before the original request starts.

```text
REQUEST
  -> SUCCESS
  -> RECOVERABLE_AUTH_ERROR
       -> NO_GRANT -> remove unchanged account; manual login
       -> JOIN_EXISTING_REFRESH
       -> START_REFRESH -> RECONNECTING
            -> SUCCESS -> guarded token/grant commit
            -> TERMINAL_FAILURE -> guarded clear/remove
            -> RETRYABLE_FAILURE -> retain state; inline retry
            -> STALE_OR_CANCELLED -> discard result
```

Every commit requires all of these conditions:

- the originating account still exists;
- its ID equals the captured `accountId`;
- it is still the active account;
- its token equals `failedToken`;
- the caller has not been cancelled;
- the refresh result belongs to the same single-flight generation.

If any check fails, the result is inert: do not change account storage, grant storage, active account, query cache, navigation, or UI status. Account switch, removal, manual relogin, token replacement, or cancellation therefore wins over a late refresh.

Terminal refresh failure clears the grant and removes the account only through the same unchanged-account guard. Retryable failure retains both. Two VNU accounts never join one single-flight, read each other's grant, update each other's token, or invalidate each other's scoped queries.

The shared refresh operation may continue while at least one caller still waits. Cancelling one request prevents that caller's replay and mutation but does not cancel another caller's joined recovery. When all waiters cancel, abort the refresh request; any late response remains inert.

## Request retry and replay policy

The request layer attaches an internal policy. The policy is in memory only; it is not a URL parameter, query-key field, or server-visible error detail.

### Replay once after successful refresh

Replay only idempotent VNU feature reads whose server execution has no mutation or charged oracle work:

- `GET /api/vnu/raw/:page` for the existing allow-listed profile, grades, progress, exam, syllabus, and point-detail reads;
- ordinary VNU adapter-backed feature GETs if they use the same request layer and have no server-side mutation.

Replay uses the new token exactly once and carries an internal `noRefresh` marker. A second recoverable auth response is returned inline and cannot start another refresh. The replay uses the original path, parameters, and abort signal. It never copies a grant into the URL or query key.

### Refresh without automatic replay

These operations may trigger refresh but are never replayed automatically:

- `POST /api/vnu/cross-lookup/bulk`;
- cross-lookup GETs that reserve or consume a probe budget;
- any future request with an upstream mutation or server-side charged side effect.

After successful refresh, the caller receives an internal `VNU_REQUEST_NOT_REPLAYED` result and decides whether to expose a manual retry. This is client-only control flow, not a worker error code.

### Never refresh or replay

- manual login, refresh, logout, CAPTCHA, and other authentication routes;
- requests already carrying `noRefresh`;
- non-VNU requests;
- `VNU_PROFILE_INCOMPLETE` and every error outside the exact trigger allow-list.

TanStack Query's global `retry` function returns false for session-terminal codes, both exact refresh triggers, all terminal refresh failures, and `VNU_REQUEST_NOT_REPLAYED`. This prevents Query from adding attempts around the request-layer single refresh/replay. Existing retry behavior may continue for unrelated transient failures.

## Bulk semantics

Bulk processing remains chunked and preserves acknowledged progress.

If a bulk POST receives a recoverable auth error:

1. Join or run refresh.
2. Never resend the failed POST automatically, even after refresh succeeds.
3. Preserve all items returned by earlier completed chunks and their export state.
4. Treat the entire unacknowledged failed chunk plus later chunks as remaining. The server may have performed part of the failed chunk before its response failed; the browser cannot infer item completion.
5. Stop processing and show a manual **Retry remaining** action.
6. A user click sends the remaining targets under the new token as a new explicit operation.

Cancellation during refresh or bulk execution preserves prior acknowledged results and exports. It sends no later chunk and applies no late refresh mutation.

## User experience

While refresh runs, show a polite, nonblocking reconnecting status near the affected content. Existing data remains visible. Do not redirect, clear the page, open the login screen, or show repeated toasts.

Successful refresh clears the reconnecting status and invalidates VNU queries once for the recovered account. Joined callers must not each invalidate. Safe failed reads then replay once. Bulk and charged cross-lookups show their manual retry state instead.

Retryable refresh failure replaces reconnecting status with inline retry copy. Terminal failure removes only the unchanged affected account and follows existing account-switch/login behavior. If another account exists, switch behavior remains local-account scoped.

All new user-facing copy is added to both English and Vietnamese dictionaries in `apps/web/src/lib/i18n.tsx`.

## Concurrency and race invariants

1. At most one browser refresh runs for one `(accountId, failedToken)`.
2. Different account IDs or failed tokens never share a promise.
3. At most one authoritative VNU login proceeds for one active grant ID.
4. A successful rotation makes the previous grant unusable until its original expiry.
5. No refresh result updates an account whose ID, active status, or token changed.
6. Manual login, account switch, explicit removal, and cancellation take precedence over late results.
7. A request replays at most once and never refreshes its replay.
8. A bulk or charged request never replays automatically.
9. Query-level retries never multiply authentication attempts.
10. One successful single-flight causes at most one account update and one VNU-query invalidation.
11. Grant expiry never extends during refresh.
12. No failure path converts profile incompleteness into a login loop.

## TDD plan and test matrix

Implementation follows red-green-refactor. Each behavior starts with a focused failing test; production changes follow only after the failure proves the intended gap.

### Core grant cryptography

Likely files:

- `packages/core/src/index.ts`
- `packages/core/src/session.test.ts`

Tests:

1. Grant round trip validates version, purpose, university, identity, and timestamps.
2. Access tokens cannot decrypt as grants; grants cannot decrypt as access tokens.
3. Wrong key, changed ciphertext, malformed shape, wrong purpose/version, and expired grant return only stable sanitized errors.
4. Encryption uses independent IVs.
5. Rotation retains the original eight-hour expiry.
6. Tests contain no realistic identities or secret-like fixtures.

### VNU error classification

Likely files:

- `apps/worker/src/app.ts`
- `apps/worker/src/app.test.ts`
- `apps/worker/src/vnu-student-id-resolver.ts`
- `apps/worker/src/vnu-student-id-resolver.test.ts`
- `packages/university-adapters/src/vnu/adapter.ts`
- relevant VNU adapter/parser tests

Tests:

1. Missing `session.vnu.value` returns `VNU_LOGIN_REQUIRED` with exact `MISSING_VNU_CREDENTIAL` reason.
2. Missing or malformed internal student ID, university ID, or required student code returns `VNU_PROFILE_INCOMPLETE`.
3. Structural failures never carry the recoverability reason.
4. Existing definitive expiry remains `VNU_SESSION_EXPIRED`.
5. Error envelopes omit profile values and upstream prose.

### Durable Object coordinator

Likely files:

- new `apps/worker/src/vnu-refresh-control.ts`
- new `apps/worker/src/vnu-refresh-control-durable-object.ts`
- corresponding unit tests
- `apps/worker/src/index.ts`
- `apps/worker/src/index.node.ts`
- `apps/worker/src/app.ts`
- `apps/worker/wrangler.jsonc`
- generated Worker environment types if maintained by the repository

Tests:

1. HMAC-derived object names are stable and contain no raw input.
2. First begin creates a lease and consumes one attempt atomically.
3. Concurrent begin on the same grant cannot start a second login.
4. Successful completion revokes old ID and activates new ID.
5. Old ID remains rejected until its expiry.
6. Retryable abort releases the lease; terminal abort revokes the ID.
7. Expired lease recovers after a simulated Worker loss.
8. Fixed-window limit is authoritative and returns sanitized retry timing.
9. Coordinator failure fails closed with `VNU_REFRESH_UNAVAILABLE`.
10. Separate derived principals remain isolated.

### Worker routes

Likely files:

- `apps/worker/src/app.ts`
- `apps/worker/src/app.test.ts`

Tests:

1. Manual VNU login returns distinct access token and encrypted refresh grant only after verified identity.
2. Grant expiry is exactly eight hours and independent of access-token expiry.
3. Cached manual login also performs required live identity validation before grant issue.
4. Manual relogin revokes a prior active grant for the same principal.
5. Refresh rejects malformed, expired, wrong-purpose, and revoked grants without upstream login.
6. Refresh rejects access/grant university or identity mismatch.
7. Valid refresh logs in once, validates exact identity, rotates both values, and preserves grant expiry.
8. Identity mismatch and invalid credentials revoke the grant and expose no identity.
9. 429, 5xx, network, timeout, and coordinator unavailability preserve grant eligibility and stable codes.
10. Two concurrent refresh requests cannot perform two upstream logins.
11. Logout revokes the exact access token and grant; repeat logout is idempotent.
12. Responses and logs never contain credentials, grant IDs, tokens, or upstream bodies.

### Browser request coordinator

Likely files:

- `apps/web/src/lib/api.ts`
- new `apps/web/src/lib/vnu-refresh.ts`
- corresponding unit tests
- `apps/web/src/main.tsx`
- `apps/web/src/state.tsx`

Tests:

1. Only the two exact recoverable errors trigger refresh.
2. `VNU_LOGIN_REQUIRED` without the exact reason and `VNU_PROFILE_INCOMPLETE` never refresh.
3. Parallel safe GET failures for the same account/token share one refresh.
4. Successful refresh atomically replaces the unchanged account token and its grant.
5. Safe GET replays once with the new token and cannot refresh again.
6. Query retry excludes all auth-terminal and recoverable codes.
7. Invalid/revoked grant, invalid credentials, and identity mismatch clear only the unchanged affected account.
8. 429, 5xx, and network failures retain account and grant.
9. Switch, removal, manual relogin, token change, and cancellation make late success and failure inert.
10. Two VNU accounts use separate grants and single-flights.
11. One joined success invalidates VNU queries once.
12. Grants never enter `localStorage`, query keys, request URLs, or error details.

### Login, logout, UI, and bulk

Likely files:

- `apps/web/src/pages/login.tsx`
- `apps/web/src/pages/lookup.tsx`
- `apps/web/src/lib/bulk-lookup.ts`
- `apps/web/src/lib/bulk-lookup.test.ts`
- `apps/web/src/components/layout.tsx`
- `apps/web/src/lib/i18n.tsx`
- `apps/web/tests/smoke.spec.ts`

Tests:

1. Successful VNU login stores grant under returned local account ID and deletes both legacy plaintext VNU keys.
2. Failed login stores neither plaintext credentials nor a grant.
3. New tab has no grant and requires manual login.
4. Reconnecting status is polite, visible, nonblocking, and announced without repeated alerts.
5. Bulk auth recovery refreshes once but sends no automatic replacement POST.
6. Bulk retains earlier items and exports; failed chunk and later targets remain retryable.
7. Manual **Retry remaining** uses the rotated token.
8. Bulk cancellation during refresh preserves acknowledged state and applies no late result.
9. Explicit active and nonactive account removal submit the matching token/grant, await revocation, and clear matching tab storage only after success.
10. English and Vietnamese copy cover reconnecting, retryable failure, manual login, and retry-remaining states.

### Verification

Run after implementation from repository root:

```bash
pnpm --filter @hyeboard/core test
pnpm --filter @hyeboard/worker test
pnpm --filter @hyeboard/web test
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Acceptance requires the complete matrix to pass, no credential or identity material in fixtures/log assertions, one-time safe replay, zero automatic bulk replay, authoritative grant rotation/revocation, exact account race guards, and unchanged UET behavior.
