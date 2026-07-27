# VNU Cached Session Token Design

Status: approved (Option 1)
Date: 2026-07-27

## Problem and evidence

The VNU credential-import cache currently stores and returns the same encrypted Hyeboard bearer token. Logout revokes that exact outward token. A later cache hit can therefore return an already-revoked token, causing the new login and other devices using the cached value to fail immediately.

A sanitized HAR confirmed this failure: the import request returned HTTP 200 with a token created about 34 minutes earlier, then immediate profile, grades, and progress requests returned HTTP 401 with `SESSION_EXPIRED`. No raw HAR values, credentials, cookies, tokens, or personal data are part of this design.

## Goals

- Preserve VNU import caching without replaying an outward bearer token.
- Mint a distinct Hyeboard bearer token for every successful login response, including cache hits.
- Keep logout and revocation scoped to the exact outward token presented by that client.
- Preserve the imported VNU session's original expiry.
- Degrade to a fresh upstream login when a cache entry is absent, invalid, expired, or unreadable.

## Non-goals

- No frontend, API shape, route, or visible behavior change.
- No change to VNU upstream authentication, raw-page caching, or session duration.
- No global logout, device management, cache eviction endpoint, or upstream VNU logout.
- No redesign of the best-effort Cache API abstraction or token-revocation store.

## Architecture and data flow

The credential-derived HMAC cache key remains unchanged. Change only the cached value and cache-hit handling in the VNU import branch.

### Cache miss

1. Call the VNU adapter with the submitted credentials and validate the upstream login as today.
2. Encrypt the imported `EncryptedSessionPayload` as a cache seed.
3. Store only that encrypted seed plus non-sensitive response metadata, with TTL derived from the payload's original `expiresAt`.
4. Independently encrypt the same payload again and return this second token to the client.

The two `encryptSession` calls use independent random AES-GCM IVs. The cached seed and returned bearer token must differ even though they decrypt to equivalent payloads.

### Cache hit

1. Read the encrypted seed.
2. Decrypt it with `HYEB_SESSION_SECRET`; `decryptSession` validates token structure, version, authentication tag, and payload expiry.
3. Validate that the payload represents the expected VNU session and contains the data needed by the existing response.
4. Re-encrypt the decrypted payload with a fresh AES-GCM IV.
5. Return the new token and the cached session metadata. Never return the seed itself.

Each login or device therefore receives a unique outward token while retaining an equivalent VNU upstream session.

## Security

- Never place plaintext ASP cookies, usernames, passwords, or other upstream secrets in the cache. Persistent cache content contains only the existing encrypted Hyeboard session seed and non-sensitive response metadata.
- The decrypted seed exists only transiently in request memory for validation and re-encryption.
- The cached encrypted token is seed material only. It is never replayed as an Authorization bearer token or returned to a client.
- Continue deriving the cache key with keyed HMAC; do not expose credentials in cache URLs, logs, errors, tests, or fixtures.
- Do not log cached values, decrypted payloads, cookies, bearer tokens, or HAR content.
- Fresh IV generation must use the existing `encryptSession` implementation; no new cryptography or deterministic token derivation is introduced.

## Expiry semantics

Re-encryption changes token identity, not session lifetime. Preserve the seed payload's original `expiresAt`; do not extend or reset it on a cache hit.

Treat an expired or undecryptable seed as a cache miss and perform a fresh upstream login. The same fallback applies to malformed entries, wrong token versions, failed AES-GCM authentication, invalid VNU payloads, or metadata inconsistent with the decrypted payload. Do not return the cache parsing error to the user when normal upstream authentication can recover.

Write cache entries only with a positive TTL bounded by the imported session's remaining lifetime. A failed or skipped write must not fail an otherwise successful login.

## Logout and revocation

Logout continues revoking the exact outward bearer token supplied in the request until its original expiry. It does not revoke or delete the cache seed.

Because the seed is never accepted or returned as that outward token, revoking one device's token cannot poison the cache. A later cache-hit login mints a different token, so it remains usable while the old token continues returning `SESSION_EXPIRED`. Other independently minted device tokens remain unaffected.

This change does not add upstream VNU logout. Cached logins may continue sharing the same still-valid upstream ASP session until its original expiry.

## Cache failure fallback

Cache remains an optimization, not an authentication dependency:

- Read failure behaves as a miss and runs the normal upstream login.
- Decryption, validation, or expiry failure bypasses the entry and runs the normal upstream login.
- Write failure still returns the freshly minted outward token from the successful upstream login.
- Upstream login failure keeps existing error behavior; cache failure must neither hide nor replace it.

## Regression tests

Add focused worker tests covering:

1. **Cache miss:** one upstream import occurs; an encrypted seed is cached; the returned token is valid and differs from the seed.
2. **Cache hit:** no second upstream import occurs; the returned token differs from both the seed and prior outward token; decrypted payloads are equivalent and retain the same `expiresAt`.
3. **Logout then relogin:** logout revokes the old outward token; that token fails with `SESSION_EXPIRED`; a cache-hit relogin returns a different token that successfully accesses a VNU authenticated route.
4. **Device isolation:** revoking one outward token does not invalidate another token minted from the same seed.
5. **Malformed seed:** malformed, wrong-version, or undecryptable cache content triggers one fresh upstream import and returns a valid token.
6. **Expired seed:** an expired cached payload triggers one fresh upstream import; its old expiry is never extended by re-encryption.
7. **Cache failures:** simulated read and write failures preserve successful upstream-login behavior and existing response shape.

Use synthetic credentials, cookies, and tokens only. No HAR-derived values, personal data, or real account material may enter tests or snapshots.

## Verification

Run from repository root:

```bash
pnpm --filter @hyeboard/worker test
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Confirm tests prove token inequality, decrypted-session equivalence, unchanged expiry, exact-token revocation, cache fallback, and unchanged JSON response shape. No frontend-specific test changes are expected.
