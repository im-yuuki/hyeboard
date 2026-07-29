# HAR Security

HAR captures are sensitive. They may contain cookies, SAML responses, OAuth codes, tokens, student IDs, names, emails, and internal endpoint details.

Rules:

- Never commit raw `.har` files.
- Never paste raw header values, cookies, SAML payloads, auth codes, or response bodies containing PII into docs or logs.
- Store only manually redacted samples under `samples/har-redacted/`.
- Document endpoint shapes and field names, not real values.
- Use Worker secrets for encryption keys.

## Reconnect grant handling

Treat encrypted VNU reconnect grants as credentials. Never paste them into issues, logs, screenshots, HAR samples, query strings, exports, analytics, or test fixtures. Browser storage is limited to `sessionStorage` keys prefixed with `hyeboard.vnu.refreshGrant.`; new VNU server logs contain only stable operation, code, and status fields.
