# Connect the receiver to Webex Contact Center

Use a test organization and synthetic conversations. You need a Full Admin who can authorize
a Service App and an administrator who can edit, validate, and publish the test flow.

## 1. Prepare a reachable receiver

1. Install Node.js 24 and run `npm ci`.
2. Obtain a currently valid, publicly issued TLS certificate and full chain for your receiver hostname.
   Store the certificate and private key outside Git; the local `certs/` directory is ignored.
   Inspect the hostname, validity, signature, and key strength with
   `openssl x509 -in certs/fullchain.pem -text -noout`. Use RSA keys of at least 2048 bits or modern EC keys.
3. Expose the receiver through a network path that supports HTTP/2 gRPC streaming and TLS 1.3.
   The sample terminates TLS itself. If you use a proxy, configure TLS passthrough and
   long-lived streams; an ordinary HTTP/1.1 forwarding tunnel is insufficient.
4. Select the final public data-source URL. Its hostname must meet the Service App's data
   exchange domain rule. A domain is entered without a port in Service App configuration;
   the registered URL must include the actual public port when it is not 443.

## 2. Authorize a Service App and register its data source

Follow the current [Media Forking guide](https://developer.webex.com/webex-contact-center/docs/media-forking-guide)
and [Data Sources API](https://developer.webex.com/webex-contact-center/docs/api/v1/data-sources) for the exact
request schema and your tenant's supported values:

1. Create a Service App with the Media Forking schema and a data exchange domain owned by the app owner.
2. Request `spark-admin:datasource_read` and `spark-admin:datasource_write`.
3. Have the test organization's Full Admin authorize the app in Control Hub and obtain
   organization-specific access/refresh tokens. For non-affiliated customer organizations,
   follow the guide's App Hub review and authorization requirements.
4. Use the organization-specific Service App access token to register the data source.
   Supply its endpoint URL, the selected Media Forking schema ID, audience, subject, nonce,
   and supported token lifetime. Do not reuse a BYOVA schema ID.
5. Record the returned data-source ID in your private deployment notes.
6. Arrange data-source updates before the JWS expires, including a new nonce and the full
   required payload/status. The guide currently limits the lifetime to 1440 minutes.
   OAuth access-token refresh and data-source JWS renewal are separate lifecycle operations.

The sample deliberately does not hold OAuth credentials or automate app authorization,
data-source creation, or token renewal. Those are administrative setup steps; the receiver
validates the JWS that Webex presents at media connection time.

## 3. Configure and run the receiver

Copy `.env.example` to `.env` and set:

| Variable                        | Source                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `JWS_ISSUERS`                   | Exact trusted Webex issuer(s) for your tenant/region, including any path such as `/idb`; confirm from trusted tenant documentation |
| `JWS_AUDIENCE`, `JWS_SUBJECT`   | Values registered for the data source                                                                                              |
| `CUSTOMER_ORG_ID`               | Authorized test organization's UUID                                                                                                |
| `MEDIA_FORKING_SCHEMA_ID`       | Media Forking schema selected for this Service App                                                                                 |
| `DATASOURCE_URL`                | Exact registered endpoint URL, including the port/path/trailing slash if present                                                   |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Local full-chain certificate and matching private-key paths                                                                        |
| `PORT`                          | Local TLS listener port; defaults to 8443                                                                                          |

Run `npm start`. Startup requires all trust bindings and a valid certificate for the
registered hostname. It has no authentication-disable setting.

For each media RPC the receiver:

- Allows only `RS256` with a key ID and an explicitly configured issuer before any key fetch.
- Retrieves keys from the configured issuer's `/oauth2/v2/keys/verificationjwk/` endpoint over HTTPS;
  redirects are rejected, fetches time out, and keys are cached.
- Verifies the signature, expiration, audience, subject, JWT ID, endpoint URL, schema ID, and organization.
- Validates the opening metadata's customer organization against the verified identity and keeps one conversation per RPC.
  Later packets may omit that organization and the format; the receiver applies only previously validated metadata for the same leg.
  Explicit mismatches remain errors.

The health service's `Check` RPC is available on the same TLS listener without a JWS.
This is the Cisco `com.cisco.wcc.ccai.v1.Health` protobuf service, not the standard
`grpc.health.v1.Health` service or an HTTP GET health page. The receiver implements `Check`;
the optional `Watch` RPC is not implemented. Readiness becomes `NOT_SERVING` while draining or at capacity.

## 4. Configure the test flow

1. Enable the test agent for Contact Center and assign a site, desktop profile, and team.
   Ensure the target queue distributes calls to that team and the agent can answer calls.
2. In a regular inbound flow, route the main path through **Queue Contact** to that queue.
3. Open **Event Flows** and add **Start Media Stream** after **AgentAccepted**
   (called **AgentAnswered** in older flows). This runs after the agent connects.
4. In **Media streaming settings > Media destination**, select the authorized **Service App** directly.
   Media Forking does not use a separate configuration under Integrations > Features.
5. Connect both the success and failure exits to **End Flow** so the event handler finishes.
6. Validate and publish the flow, then map the test entry point to its published version label.
7. Make the agent available and follow [the real-call validation checklist](VALIDATION.md).

The activity needs an answered caller-agent conversation. An ordinary main path normally
runs before agent connection and can fail with `callNotAnswered`.

The media stream begins when the flow executes the activity for the live-agent conversation.
The sample receives a copy of that audio; it does not participate as a virtual agent.

## Troubleshooting

| Symptom                       | Check                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No connection                 | Public DNS/port reachability, HTTP/2 and TLS 1.3 support, certificate chain, data-source health, and activity execution        |
| `UNAUTHENTICATED` (16)        | Expired JWS, exact trusted issuer/key ID, audience/subject, registered URL/schema, organization binding, and JWKS reachability |
| `INVALID_ARGUMENT` (3)        | Missing or inconsistent conversation/organization/leg identifiers, unknown encoding/rate, or invalid capture timestamp         |
| `RESOURCE_EXHAUSTED` (8)      | Concurrent-stream, frame/message size, leg, or processor queue limits; confirm downstream processing keeps up                  |
| `DEADLINE_EXCEEDED` (4)       | 60-second inactivity timeout or two-hour stream limit                                                                          |
| `INTERNAL` (13)               | Failure in your audio handler; investigate your processor without logging audio or tokens                                      |
| Health method not found       | Use the Cisco health proto in `proto/`, not the standard gRPC health schema                                                    |
| Stream closes during shutdown | SIGINT/SIGTERM allows five seconds to finish, then cancels remaining streams                                                   |

An authentication failure is intentionally generic. Compare configured values privately
rather than copying tokens into logs or tickets. Missing audio cannot be recovered from this receiver.
