# Automation Worker

This package is a Node-only execution boundary for encrypted automation jobs.

## Integration hooks

- Construct `RedisStreamsBroker` with a connected node-redis client supplied by the host application. The package intentionally has no direct `redis` dependency and does not create a Redis connection.
- Construct `AutomationEnvelopeCodec` with the keyring parsed by `parseAutomationWorkerConfig`.
- Provide the actual UET implementation through `AutomationExecutor`. Selectors, login steps, CAPTCHA handling, and response mapping are deliberately not included here.
- Provide `createBrowserlessPuppeteerProvider` with `puppeteer.connect` (or a compatible connector). The Browserless token remains in the provider closure and is not present in connection metadata.
- Call `start()`, install `installProcessSignalHandlers()`, and call `stop()` during application shutdown. `stop()` cancels active work, waits up to the configured drain timeout, and leaves shutdown-interrupted stream entries pending.

The executable host bridge is available through `src/cli.ts` (bundled as `dist/cli.cjs`). It owns the Redis clients and Browserless/Puppeteer provider, creates the UET executor, and starts the worker/control lifecycle. The UET adapter receives the provider-owned Puppeteer session and verifies ownership before browser operations.

## Message contract

The job stream entry must contain `jobEnvelope`, an encrypted `UetImportJob` envelope using the configured job AAD. The job's `credentialEnvelope` is opened only inside the executor boundary. Successful executor output is encrypted before the `succeeded` event is emitted.

The event sink is injectable. `StreamAutomationEventSink` writes JSON events to a Redis Stream, while `InMemoryAutomationEventSink` is intended for tests.

## Limitations

- Redis Streams command methods are represented by a small structural interface so this package does not add or duplicate the existing repository Redis dependency. The host owns client connection, reconnect, TLS, ACL, and metrics policy.
- Browserless endpoint construction is abstracted around Puppeteer's `connect`; this package does not bundle Puppeteer or prescribe browser/page types.
- Fencing is represented in leases and every protocol event. Event/result consumers must reject stale fences atomically with their own state transition.
- Retryable failures remain pending until reclaim and are not emitted as terminal events. A final failure is acknowledged after `maxDeliveryCount`.
- Cancellation is cooperative. An executor that ignores `AbortSignal` can outlive the configured drain timeout; it will not be acknowledged after shutdown.

The Browserless image is pinned to `ghcr.io/browserless/chromium:v2.55.4`, was pulled manually, and started successfully; a live Puppeteer CDP smoke test passed against `ws://127.0.0.1:3000/chromium`, including a token query. The host bridge has not been validated by a real UET/Google login E2E because upstream credentials are unavailable. The live PostgreSQL and Redis HA tests pass, but those results do not establish full feature parity or Kubernetes readiness.
