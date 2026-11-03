# Validation evidence

## Repeatable local validation

Use Node.js 24 and the OpenSSL command-line tool for the TLS startup test.

```sh
npm ci
npm run check
npm run demo
npm audit
```

The demo/tests use synthetic data and in-memory keys. They do not certify the Webex
tenant integration, media delivery under real load, or a public network path.

## Live Webex Contact Center validation

Status: **pending**. A test organization will be supplied after the first PR is ready.
Do not mark the items below complete based on local tests.

- Record the PR head commit SHA, test date, and a non-sensitive environment alias.
- Confirm a publicly trusted certificate, HTTP/2/TLS connectivity, and Cisco health `Check` readiness.
- Confirm that a media RPC with no valid JWS is rejected.
- Confirm Service App authorization, data-source registration, and published flow configuration.
- Place a test call through the configured entry point and have an agent answer.
- Verify separate `CALLER` and `AGENT` receipt, conversation/leg identifiers in the handler,
  and the actual encoding, sample rate, and capture timestamps.
- End the call and verify clean completion with exactly one final acknowledgement.
- Repeat the call and verify a new stream completes without stale state.
- Test simultaneous conversations and confirm isolation.
- Exercise hold/resume, transfer/consult, and reconnection where the tenant supports them;
  record the observed lifecycle without assuming participant or reconnect semantics.
- Confirm invalid organization/data-source bindings and expired tokens are rejected.
- Check JWS renewal before expiry without publishing tokens or private configuration.

Keep organization IDs, authorization artifacts, recordings, and infrastructure details in
private deployment notes. Publish only sanitized evidence and link it from DXDOC-6470.
Performance limits and production suitability require separate validation.
