# Automation Worker

This package is a Node-only execution boundary for encrypted automation jobs.

## Integration hooks

- Construct `RedisStreamsBroker` with a connected node-redis client supplied by the host application. The package intentionally has no direct `redis` dependency and does not create a Redis connection.
- Construct `AutomationEnvelopeCodec` with the keyring parsed by `parseAutomationWorkerConfig`.
- Provide the actual UET implementation through `AutomationExecutor`. Selectors, login steps, CAPTCHA handling, and response mapping are deliberately not included here.
- Provide `createBrowserlessPuppeteerProvider` with `puppeteer.connect` (or a compatible connector). The Browserless token remains in the provider closure and is not present in connection metadata.
- Call `start()`, install `installProcessSignalHandlers()`, and call `stop()` during application shutdown. `stop()` cancels active work, waits up to the configured drain timeout, and leaves shutdown-interrupted stream entries pending.

## Message contract

The job stream entry must contain `jobEnvelope`, an encrypted `UetImportJob` envelope using the configured job AAD. The job's `credentialEnvelope` is opened only inside the executor boundary. Successful executor output is encrypted before the `succeeded` event is emitted.

The event sink is injectable. `StreamAutomationEventSink` writes JSON events to a Redis Stream, while `InMemoryAutomationEventSink` is intended for tests.

## Limitations

- Redis Streams command methods are represented by a small structural interface so this package does not add or duplicate the existing repository Redis dependency. The host owns client connection, reconnect, TLS, ACL, and metrics policy.
- Browserless endpoint construction is abstracted around Puppeteer's `connect`; this package does not bundle Puppeteer or prescribe browser/page types.
- Fencing is represented in leases and every protocol event. Event/result consumers must reject stale fences atomically with their own state transition.
- Retryable failures remain pending until reclaim and are not emitted as terminal events. A final failure is acknowledged after `maxDeliveryCount`.
- Cancellation is cooperative. An executor that ignores `AbortSignal` can outlive the configured drain timeout; it will not be acknowledged after shutdown.
