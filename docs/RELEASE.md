# Release readiness

The first release is a developer starter for receiving Webex Contact Center media,
with optional WAV capture. It supports one configured organization/data source per
receiver process. It is not a production recording platform or a virtual agent.
The repository stays private until the owner approves public release.

## Release checks

Before creating the public `v0.1.0` release:

- Verify the exact candidate commit has passing Tests and Prettier CI on Node.js 24.
  CI must exercise the demo with recording both disabled and enabled.
- From a clean checkout, run `npm ci`, `npm run check`, `npm run demo`, and `npm audit`.
  Run `RECORDING_DIR=./recordings npm run demo` and verify distinct caller/agent
  one-second tones. Run as an unprivileged account; commands and recording permissions
  are validated on macOS and Linux. Windows recording permissions are unvalidated.
- Review the source, Git history, and source archive for credentials, keys, call audio,
  customer configuration, and private deployment details. Keep `.env.example` portable.
  A pattern scan is supporting evidence and does not replace manual review.
- Read the [live evidence](VALIDATION.md) against the candidate diff. A test passing
  locally or a healthy public endpoint does not establish live media delivery.
- Live expired-JWS rejection and data-source renewal were verified on 2026-11-06; see
  [the lifecycle evidence](VALIDATION.md#live-jws-expiry-and-renewal-validation).
  Repeat these checks for another deployment. OAuth refresh and data-source JWS renewal
  are separate operations; neither is implemented by the receiver. Keep credentials private.
- Verify the README, setup instructions, protobuf provenance, license, support boundary,
  and public documentation links. Guide corrections remain tracked separately.
- Obtain the owner's public-release approval, then change visibility and publish a
  release targeting the reviewed commit. Verify anonymous repository/clone access and
  the source archive. Keep npm publishing disabled (`private: true`).
- After the sample is publicly accessible, add its link to the Developer Portal guide
  and overview through their reviewed integration and production-promotion workflow.
  Verify the rendered pages after publication.

## First-release contents

- Authenticated TLS 1.3 gRPC receiver and Cisco health `Check` service.
- Validated opening metadata, sparse packets, separate caller/agent RPCs, and optional
  capture timestamps; bounded queues, explicit overload errors, and cancellation cleanup.
- Optional private WAV files preserving LINEAR16, MULAW, or ALAW at 8/16 kHz, with final
  headers, format-change segmentation, and failure propagation before acknowledgement.
- Credential-free synthetic demo with distinct caller/agent tones, regression tests,
  configuration template, setup walkthrough, and sanitized live evidence.

## Operational limits

JWS renewal, TLS certificate renewal, encrypted storage, disk monitoring, recording
retention, and deployment are operator responsibilities. Keep recording disabled unless
needed and run the receiver as an unprivileged service user. A cancelled call can produce
a valid partial-call WAV; abrupt termination or write failure can leave `.partial` files.
There is no recording recovery, replay, gap filling, deduplication, or managed retention.

The successful live WAV test used MULAW at 8 kHz and a silent agent leg. Other codecs/rates
and concurrent conversations have synthetic coverage. Live hold/resume, transfer/consult,
reconnection, simultaneous conversations, and capacity testing remain unvalidated.
This sample is provided under the [Cisco Sample Code License](../LICENSE), without TAC
support or production capacity/reliability certification. Use sanitized repository issues
for sample bugs; follow the established Cisco security channel for sensitive reports.
