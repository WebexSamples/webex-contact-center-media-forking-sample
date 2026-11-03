# Webex Contact Center Media Forking Sample

A small Node.js receiver for Webex Contact Center's live caller and agent audio.
Use it to learn the connection lifecycle and as a starting point for your own audio processing.

The receiver implements the published `ConversationAudio.StreamConversationAudio` gRPC service
and the separate `com.cisco.wcc.ccai.v1.Health.Check` RPC. It verifies the signed JWS,
receives raw mono audio, and acknowledges the call after the client finishes sending and
the audio handler has processed the queued frames.

This sample covers receiving media. It does not transcribe, play, record, or send audio back into a call.
Although the RPC is bidirectional, the response is a final processing acknowledgement, not a voice response.

## Try it without a Webex organization

Install Node.js 24 (see `.nvmrc`), then:

```sh
npm ci
npm run demo
```

The demo starts a receiver and test client on an OS-assigned loopback port. It creates temporary
signing keys in memory, checks readiness, streams synthetic caller and agent silence, verifies
one final `SUCCESS`, and confirms that an unauthenticated stream is rejected.
No customer audio, credentials, or Webex organization is used.

Expected output includes `media_received` for `CALLER` and `AGENT`, `stream_completed`,
and `Demo passed`. The demo's plaintext loopback transport and temporary key source are
isolated in `scripts/demo.mjs` and `support/synthetic.mjs`; `npm start` always uses TLS and
Webex JWS validation.

## Connect a Webex organization

Follow [the setup walkthrough](docs/SETUP.md) for Service App authorization, data-source
registration, Control Hub, Flow Designer, and the real-call checklist.

```sh
cp .env.example .env
# Set the registered data-source bindings and your TLS certificate/key paths.
npm start
```

`npm start` loads `.env`, requires TLS 1.3, and listens on port 8443 by default.
Use a publicly trusted certificate for the registered hostname and expose the configured port
through an HTTP/2-capable network path. There is no cloud deployment or tenant configuration automation.

## Understand and extend the stream

Webex is the gRPC client; this application is the server. Every request contains:

| Field                            | Meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `conversation_id`                | Conversation identity; retained across the call            |
| `customer_org_id`                | Must match the verified JWS organization                   |
| `audio.role` and `audio.role_id` | Source role (`CALLER` or `AGENT`) and individual media leg |
| `audio.audio_data`               | Raw mono audio bytes, without a WAV header                 |
| `audio.encoding`                 | `LINEAR16`, `MULAW`, or `ALAW`                             |
| `audio.sample_rate_hertz`        | 8000 or 16000; read it from each message                   |
| `audio.audio_timestamp`          | Source capture time, in protobuf seconds and nanoseconds   |

Add your processing in [`lib/audio.mjs`](lib/audio.mjs). The handler receives the complete
validated request and an `AbortSignal`. Keep separate downstream sessions for
`(customer_org_id, conversation_id, audio.role, audio.role_id)`.
Read the declared encoding/rate on every frame; frame sizes vary. No decoding or transcoding is performed.

Keep CPU-heavy work off the Node.js event loop. For asynchronous work, honor the abort signal,
set downstream timeouts, and keep processing quick enough to consume live audio.
Webex does not provide recoverable backpressure: a receiver failure or overload can permanently lose media.
The sample fails the RPC explicitly rather than silently discarding audio and reporting success.

The limits in [`lib/receiver.mjs`](lib/receiver.mjs) are development defaults:

- 16 active media RPCs across connections, including pending authentication and processing.
- 128 KiB per protobuf message and 64 KiB per audio payload.
- Up to 128 queued frames and 1 MiB of queued/in-flight audio per RPC.
- 16 media legs per RPC, a 60-second idle timeout, and a two-hour maximum duration.

Default logs contain a receiver-generated stream ID, role, format, frame/byte counts, and timestamps.
They omit raw audio, tokens, organization IDs, conversation IDs, and source role IDs.
The handler receives the original identifiers so developers can correlate downstream work.
There is no audio storage or web dashboard.

This starter accepts one configured customer organization and data-source binding per process.
Re-established streams are separate RPCs; it does not persist or deduplicate media.
Before adding external writes, design idempotency around the conversation/leg identity and your
consumer's semantics. Capture timestamps alone are not a documented unique packet sequence.

## Validate changes

```sh
npm run check
npm run demo
npm audit
```

Tests use Node's built-in runner, synthetic signing keys, and real local gRPC connections.
They cover token validation, both roles, concurrent calls, declared formats, lifecycle,
overload, cancellation, and error propagation. CI runs the tests, demo, dependency audit,
and formatting checks. No live tenant is contacted by CI.

Live WxCC validation is pending. Use [docs/VALIDATION.md](docs/VALIDATION.md) to record
the delivered commit and the eventual test-organization evidence.

## Source and references

The three protobuf files under `proto/` are copied unchanged from the
[CiscoDevNet provider reference](https://github.com/CiscoDevNet/webex-contact-center-provider-sample-code/tree/0db3a6a56195f5708cc47f3d7c13f0f3dafa716d/media-forking/simulators/media-forking-java/src/main/proto),
commit `0db3a6a56195f5708cc47f3d7c13f0f3dafa716d`. This receiver is a new implementation;
it does not reuse the reference's Java authentication code.

- [Media Forking overview](https://developer.webex.com/webex-contact-center/docs/media-forking-overview)
- [Media Forking guide](https://developer.webex.com/webex-contact-center/docs/media-forking-guide)
- [Data Sources API](https://developer.webex.com/webex-contact-center/docs/api/v1/data-sources)
- [Service Apps](https://developer.webex.com/admin/docs/service-apps)
- [Tracking: DXDOC-6470](https://jira-eng-gpk2.cisco.com/jira/browse/DXDOC-6470)

## Contributing and license

Run the validation commands before submitting a pull request. Use synthetic data in tests.
Do not commit credentials, private keys, certificates, customer audio, or tenant-specific configuration.
Report sensitive security issues through your established Cisco security reporting channel rather
than placing credentials or customer data in an issue.

This repository uses the WebexSamples template and the [Cisco Sample Code License](LICENSE).
It is sample code and has not been certified for production capacity or reliability.
