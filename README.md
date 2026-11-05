# Webex Contact Center Media Forking Sample

A small Node.js receiver for Webex Contact Center's live caller and agent audio.
Use it to learn the connection lifecycle and as a starting point for your own audio processing.

The receiver implements the published `ConversationAudio.StreamConversationAudio` gRPC service
and the separate `com.cisco.wcc.ccai.v1.Health.Check` RPC. It verifies the signed JWS,
receives raw mono audio, and acknowledges the call after the client finishes sending and
the audio handler has processed the queued frames.

This sample covers receiving media, with optional WAV recording. It does not transcribe, play, or send audio back into a call.
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

Webex is the gRPC client; this application is the server. Webex can open separate RPCs for the caller and agent. Each leg starts with identity/format
metadata without audio bytes or a capture timestamp. Subsequent packets can omit the org,
encoding, sample rate, and timestamp. The receiver applies validated opening metadata to
that leg's audio packets and invokes the audio handler only for non-empty audio.

The handler receives these fields:

| Field                            | Meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `conversation_id`                | Conversation identity; retained across the call            |
| `customer_org_id`                | Validated against the JWS; retained from opening metadata  |
| `audio.role` and `audio.role_id` | Source role (`CALLER` or `AGENT`) and individual media leg |
| `audio.audio_data`               | Raw mono audio bytes, without a WAV header                 |
| `audio.encoding`                 | `LINEAR16`, `MULAW`, or `ALAW`                             |
| `audio.sample_rate_hertz`        | 8000 or 16000; retained from metadata when omitted         |
| `audio.audio_timestamp`          | Source capture time if supplied; otherwise `null`          |

Add your processing in [`lib/audio.mjs`](lib/audio.mjs). The handler receives the complete
validated, normalized audio request and an `AbortSignal`. Keep separate downstream sessions for
`(customer_org_id, conversation_id, audio.role, audio.role_id)`.
Read the normalized encoding/rate on every frame; frame sizes vary. Do not invent capture timestamps when Webex omits them. No decoding or transcoding is performed.

Keep CPU-heavy work off the Node.js event loop. For asynchronous work, honor the abort signal,
set downstream timeouts, and keep processing quick enough to consume live audio.
Webex does not provide recoverable backpressure: a receiver failure or overload can permanently lose media.
The sample fails the RPC explicitly rather than silently discarding audio and reporting success.

The limits in [`lib/receiver.mjs`](lib/receiver.mjs) are development defaults:

- 16 active media RPCs across connections, including pending authentication and processing.
- 128 KiB per protobuf message and 64 KiB per audio payload.
- Up to 128 queued frames and 1 MiB of queued/in-flight audio per RPC.
- 16 media legs per RPC, a 60-second idle timeout, and a two-hour maximum duration.

Default logs contain a receiver-generated stream ID, role, format, frame/byte counts, and supplied timestamps.
Rejected-frame diagnostics contain field names only.
They omit raw audio, tokens, organization IDs, conversation IDs, and source role IDs.
The handler receives the original identifiers so developers can correlate downstream work.
Recording is disabled unless `RECORDING_DIR` is set. There is no web dashboard.

This starter accepts one configured customer organization and data-source binding per process.
Re-established streams are separate RPCs; it does not deduplicate media.
Before adding external writes, design idempotency around the conversation/leg identity and your
consumer's semantics. Capture timestamps alone are not a documented unique packet sequence.

## Record WAV audio

Set `RECORDING_DIR=./recordings` in `.env` and run `npm start` to save incoming media.
To try recording synthetic caller and agent silence without a Webex organization:

```sh
RECORDING_DIR=./recordings npm run demo
```

Like the BYOVA Python recorder, this wraps the received bytes in a WAV container without
transcoding: mono LINEAR16 (PCM), MULAW, or ALAW at the declared 8000/16000 Hz rate.
Use a player supporting the recorded codec, such as VLC or ffplay. Each RPC/participant
leg gets a separate file, named `<stream-id>_<leg>_<CALLER|AGENT>_<segment>.wav`.
The generated stream ID matches receiver logs; source organization/conversation/role IDs
are not included in filenames or logs. Reconnects start new files. A format change starts
a new segment, with a maximum of 32 segments per leg. Files contain received audio in
arrival order; they do not mix participants, insert silence for gaps, or align timestamps.

The writer streams to disk and renames `.wav.partial` to `.wav` only after writing the
final header, syncing, and closing. `recording_saved` logs identify finalized files and
their format/byte count. A success acknowledgement waits for recording finalization.
Cancellation, timeout, or handler failure finalizes audio already written; the WAV may
cover only part of a call, so also check `stream_completed`/`stream_failed` logs. A process
crash or disk error can leave `.partial` files. Incomplete LINEAR16 samples and RIFF size
overflow fail explicitly. There is no recovery or automatic deletion of these artifacts.

The directory is created with mode `0700`; an existing directory must also be private.
Files use mode `0600`. Keep the directory outside any web-served path and provide a
writable persistent volume if running in a container or restricted service. Recordings
are sensitive call data: use an appropriately encrypted disk, restrict access, and set
your own retention/cleanup policy. Monitor disk space; disk exhaustion fails the stream.
WAV files and partial recordings are excluded from Git. Recording stays off by default.

## Validate changes

The TLS startup test also requires the OpenSSL command-line tool on your PATH.

```sh
npm run check
npm run demo
npm audit
```

Tests use Node's built-in runner, synthetic signing keys, and real local gRPC connections.
They cover token validation, both roles, concurrent calls, declared formats, lifecycle,
overload, cancellation, and error propagation. CI runs the tests, demo, dependency audit,
and formatting checks. No live tenant is contacted by CI.

Two agent-answered SDK calls verified caller and agent media receipt and clean receiver completion
in a test organization. See [docs/VALIDATION.md](docs/VALIDATION.md) for the code revision,
observed wire behavior, and remaining live coverage.

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
