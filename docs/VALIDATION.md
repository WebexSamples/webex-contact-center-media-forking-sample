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

## WAV recording validation

Receiver code: `12b53b47ef563185e9ea362a76e596e49bf415c5`.
Local regression tests verify
separate leg files, native PCM/MULAW/ALAW headers at both sample rates, byte preservation,
G.711 padding, format changes, split PCM samples, concurrent/reconnected stream isolation,
metadata-only and unauthorized streams, cancellation cleanup, private filesystem permissions,
overload cleanup, and explicit failure on write errors or incomplete PCM samples.
Independent FFmpeg/ffprobe checks decoded all six encoding/rate combinations and verified
mono channels, duration, and decoded sample counts. The recording-enabled synthetic demo
also produced separate caller and agent WAV files. All 39 tests, formatting checks, both
demo modes, and npm audit (zero vulnerabilities) passed. The same 39 tests also passed
on the non-production AWS host using Node.js 24.

On 2026-11-05, recording was enabled on the existing non-production receiver using a
private directory on encrypted storage. Two further agent-answered SDK calls produced
separate caller and agent WAV files. The first call was answered after a re-offer near
the caller's termination and captured only 0.46 seconds per leg. The longer repeat call
captured **37.8 seconds / 302400 audio bytes per leg**, mono MULAW at 8000 Hz. The caller
recording contains non-silent audio; the agent remained silent during the test.

All four WAV files had valid RIFF/fmt/fact/data sizes, decoded successfully on the host,
and had mode `0600`. No `.partial` files remained. The repeat streams each logged
`recording_saved` followed by `stream_completed`, without receiver failures or frame
rejections. Both SDK runs completed. Audio stayed on the private host; intelligibility
was not assessed by listening. Trusted TLS, public health readiness, anonymous-media
rejection, persisted service/configuration, and isolation from the existing BYOVA runtime
were verified after deployment. Retention remains an operator responsibility.

## Earlier live Webex Contact Center validation

Status: **core live path verified on 2026-11-05** in a non-production sandbox.
Receiver code: `d7314d9d432178537ceb19067bab13d714aa3788`.

Two agent-answered calls were placed with the BYOVA gateway's Webex Calling SDK
E2E caller through the published inbound flow. For each call, the receiver accepted
separate caller and agent RPCs, processed media, and logged clean completion after
sending one final acknowledgement per RPC:

| SDK call              | Role   | Frames |  Bytes | Format         |
| --------------------- | ------ | -----: | -----: | -------------- |
| First successful call | CALLER |    180 | 230400 | MULAW, 8000 Hz |
| First successful call | AGENT  |    180 | 230400 | MULAW, 8000 Hz |
| Repeat call           | CALLER |     79 | 100800 | MULAW, 8000 Hz |
| Repeat call           | AGENT  |     79 | 100800 | MULAW, 8000 Hz |

No frame rejections or stream failures occurred in that receiver window. The client
reported completed runs and caller-requested termination. This proves media delivery
and the receiver completion path; it does not measure intelligibility or prove that
Webex consumed the final acknowledgement. No audio was stored by the receiver.

Observed wire behavior: metadata-only opening messages carry org/leg identity and format;
subsequent audio packets omit org/format fields and capture timestamps. The receiver
retains validated per-leg metadata and leaves omitted timestamps `null`.

The sandbox agent initially had Contact Center disabled and no site/team/desktop profile;
those were configured before testing. The flow uses **AgentAccepted > Start Media Stream**
and selects the authorized Service App directly. No Integrations > Features configuration
was required. Public TLS/HTTP2 routing, Cisco health readiness, and anonymous-media
rejection were also verified during setup.

Private deployment notes retain the SDK run artifacts, receiver logs, call identifiers,
and tenant configuration. Tracking: **DXDOC-6482**, under **DXDOC-6470**.

Remaining live coverage: simultaneous conversations, hold/resume, transfer/consult,
reconnection, expired-token behavior and JWS renewal. Automated local tests cover
binding rejection and concurrency but do not replace those live checks. Performance
and production suitability remain unvalidated.

### Checklist for another organization

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
