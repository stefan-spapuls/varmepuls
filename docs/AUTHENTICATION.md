# Varmepuls authentication and device identity

Status: the device-authentication implementation passed offline qualification, was deployed with migration 0002, and passed the bounded synthetic Phase 3D-R2 remote qualification. No real device is enrolled, no real credential exists, and Cloud has zero real hardware authority. Remote plan-payload delivery remains unqualified until a legitimate demo plan is available. See [local qualification evidence](AUTHENTICATION_LOCAL_QUALIFICATION.md), [deployment status](CLOUD_DEPLOYMENT.md), and [feasibility evidence](AUTHENTICATION_FEASIBILITY.md).

## 1. Threat model

Protect against a device credential being copied, an attacker guessing or replaying a pairing invitation, one device reaching another installation, stale/revoked devices continuing to read data, and credentials leaking from source control or logs. Assume TLS and Cloudflare’s service are correctly operated for normal network protection. Rate-limit unauthenticated enrollment/challenge operations and return generic errors where responses could reveal whether an identity exists.

Authentication establishes which enrolled device made a request. Authorization separately limits that device to its own installation and explicit device scopes. An installation ID, device ID, or credential ID is an opaque selector, never a credential or proof of authority.

## 2. Installation and device identities

An installation is one household/system boundary. A device is one local controller belonging to exactly one installation at a time. An installation may later have multiple devices. A device transfer to another installation is revoke-and-pair; it is never an in-place reassignment.

Generate installation IDs and device IDs independently from at least 128 bits of a cryptographically secure random source, encoded as opaque UUIDs or base64url values. Keep a separate random credential ID for each public key/version. IDs must not contain a person, address, email, IP address, or hardware serial. Knowing an ID grants no access.

## 3. Authentication and authorization

Future device scopes are narrowly defined:

- `config:read`: read the authenticated device’s installation configuration.
- `plan:read`: read plans for that same installation.
- `state:report`: a future bounded state-report operation; not included in Phase 3D’s first API.

Devices cannot write configuration, create plans, pair devices, revoke devices, or address another installation. Future human roles are separate: an installation owner may read state and request configuration changes; an installation administrator may create enrollment opportunities and revoke devices. Full app/user authentication and those public owner endpoints are deferred.

Never trust an installation ID supplied in a URL as the authorization scope. Authentication resolves the credential ID to a device record; authorization derives the installation from that record. A URL ID, if present, must match the derived installation or receive a generic forbidden/not-found response. Synthetic remote qualification proved installation-scoped configuration access and isolation. No real device is active.

## 4. Credential and verifier storage

Recommended long-term device credential: a per-device Ed25519 signing key pair. The controller generates its private key locally and never exports it. Cloud stores only the public key, credential ID/version, status, and owning installation. This is a pinned public key per device, not a certificate authority, certificate chain, or shared device secret. It permits request signatures while keeping reusable private credentials out of D1. Confirm that the eventual controller runtime supports the selected standard Ed25519 API before implementation; do not substitute custom cryptography.

Enrollment uses a distinct, one-time random 256-bit capability. Store only a SHA-256 verifier over a domain-separated value containing the enrollment ID and token. Its entropy makes offline guessing infeasible; a password KDF and per-row salt are unnecessary for this machine-generated token. Compare fixed-length digests without early exit. The token is not a device credential, is never reused for normal requests, and is removed/marked consumed atomically when enrollment succeeds.

The local controller stores its private key in its best available protected local storage, along with opaque device/credential IDs and the pinned Varmepuls service identity. It must never log or export the private key. If secure hardware storage is unavailable, document the host OS protection and physical compromise risk. The public repository may contain schemas, source, protocols, and synthetic test vectors only; never real private keys, pairing codes, household records, or credentials.

The implementation stores server-side verifier/public-key material and uses synthetic controller key pairs in tests and the bounded remote qualification. It does not generate or store controller private keys; controllers generate and retain those locally. No real credential was created.

## 5. Pairing and enrollment

The eventual homeowner flow is: the owner selects “Add controller” for one installation; an authenticated owner action creates an invitation bound to that installation and expiring after five minutes; the app presents it as a QR code; the untrusted controller scans it, generates its own key pair, and submits the one-time capability plus its public key over TLS; Cloud atomically consumes the invitation and creates one device under the invitation’s installation. The homeowner does not transcribe a long secret. Never accept a target installation from the controller as authority to choose its owner.

Enrollment is single-use. Expired, malformed, or invalid proof creates no device. Failed guesses do not consume a valid invitation, but they are rate-limited; after successful use, replay fails. Do not put capability values in URLs, logs, analytics, or support output. The invitation verifier and device public key are different records and serve different purposes.

Until app/user authentication exists, the smallest initial operator path is an owner-operated local pairing command authenticated through the existing Cloudflare operator session. It creates a bounded invitation for an explicitly selected installation and displays a QR locally. This is an interim administrative workflow, not a public Worker endpoint or a new global device secret. Replace it with an authenticated owner session before ordinary app-based pairing is offered.

## 6. Request replay protection and clock recovery

Require TLS for every credential-bearing request. Do not use query-string credentials. A signature over each request protects against a stolen credential ID alone, while a one-use server challenge makes a captured signed request unusable a second time.

For an authenticated operation, the controller first requests a short-lived challenge (target lifetime: 120 seconds). Cloud creates a cryptographically random nonce bound to the device, credential version, HTTP method, canonical path, and SHA-256 body digest. The controller signs a versioned canonical encoding of those fields plus the challenge ID and nonce. Cloud verifies with the stored public key and atomically consumes the challenge before returning protected data or accepting a future bounded report. Challenge IDs are single-use; expiry, wrong method/path/body, wrong device/key version, invalid signature, or replay is rejected. Retry after an uncertain response obtains a fresh challenge. Read endpoints remain read-only; later mutations also need explicit idempotency semantics. The exact Phase 3C.1 encoding and SQL proof are recorded in [AUTHENTICATION_FEASIBILITY.md](AUTHENTICATION_FEASIBILITY.md).

This request/response challenge avoids trusting the controller clock. The controller can authenticate after a reboot with incorrect wall time: it asks Cloud for a fresh challenge and signs the returned bytes. The unauthenticated challenge operation returns no installation data or mutation capability and must be rate-limited. Enrollment expiry is checked with Cloud time, never controller time. Do not relax signature, nonce, or authorization checks to provide clock bootstrap.

## 7. Revocation and replacement

Revocation changes one device record to revoked and invalidates its current and pending credential versions. Other devices in that installation and all other installations remain unchanged. Check revocation against authoritative state on each authenticated request; do not cache positive authorization. Target behavior is rejection on the next request after the revocation commit. If the selected D1 access mode cannot provide that freshness, publish and test a strict maximum revocation delay before launch; never claim immediate revocation without evidence.

If a controller is lost, stolen, reset, or dead, revoke its device identity and pair a replacement under the same installation. Keep installation configuration and plans intact. Never restore or reuse the old controller credential. A reset controller is treated as a new untrusted device.

## 8. Rotation and interrupted recovery

Start rotation only after authenticating with the current private key. Register a new key version and allow a maximum ten-minute transition. During that window the old key retains its existing authority; the pending new key may only confirm rotation. On confirmation, make the new version current and invalidate the old one immediately. Never allow an unbounded dual-key period.

If connectivity fails or the controller loses power before confirmation, the window ends deterministically by discarding only the unconfirmed pending key. The last confirmed old key remains the sole active key, so a transient outage does not strand a legitimate controller. The device can retry rotation. If the old key itself is lost or suspected compromised, the owner revokes it and pairs a replacement; installation identity/configuration remain. A confirmed rotation immediately invalidates the old key, and pending state/deadline must persist across Worker restarts.

## 9. Installation isolation and plan authorization

Every config/plan query is keyed by the installation derived from the authenticated device row. A request path cannot broaden that scope. A device for Installation A cannot read Installation B config or plans, change either installation, or authenticate using B’s credential. Revocation and key versions are device-specific.

Only return a plan belonging to the authenticated installation. Device authentication does not make a plan safe to execute. The future local controller independently verifies installation identity, plan and configuration revisions, time validity, input coverage, schema, and local safety constraints before execution. Cloud is never the final equipment-safety boundary.

## 10. Cloud compromise boundary

Per-device keys, scopes, one-use pairing, and revocation reduce cross-device and cross-installation access after a single device credential is compromised. A D1-only disclosure exposes public keys and verifier metadata, not device private keys or enrollment capability plaintext.

If Cloud/Worker execution or its signing/authorization path is fully compromised, an attacker may publish malicious plans, alter cloud configuration, or misuse active enrollment/revocation authority. Authentication cannot prove that a cloud-generated plan is safe. Local validation and independent safety interlocks remain mandatory. A compromised controller can still affect its local installation within its local hardware authority; revocation limits subsequent cloud access but cannot undo local compromise.

## 11. Public/private boundary

Publish the identity model, migration source, Worker source, endpoint contract, and synthetic offline tests. Keep production private keys, one-time invitation values, user/device records, household configuration, and private telemetry out of Git and logs. Deployment-specific secrets and identifiers belong only in private runtime configuration. No unrelated-project source, credentials, schema, or data belong in this repository.

## 12. Deployed API surface and qualification status

The eventual route families are:

- `POST /v1/enrollments/consume`: submit one-time invitation and device public key; no installation selector is trusted from the body.
- `POST /v1/device/challenges`: request a bounded, one-use challenge.
- `GET /v1/device/config` and `GET /v1/device/plan`: signed, installation-scoped reads.
- `POST /v1/device/rotation` and `/v1/device/rotation/confirm`: start rotation with the current key and confirm with the new key; the ten-minute overlap policy above applies.
- Future owner-only pairing/revocation operations require authenticated user authorization; they are not public in the initial device API.
- Future state reporting and configuration writes require separate scope and validation designs.

Synthetic R2 qualification exercised enrollment, signed configuration reads, replay and tamper rejection, installation isolation, challenge concurrency, rotation, revocation, and cleanup against the deployed Worker/D1. The plan route was not remotely exercised because there is no legitimate persistent demo plan; plan immutability was preserved. There is no public enrollment-creation or revocation route. No synthetic R2 rows remain, and no real invitation or device exists.

## 13. Minimum additional persistent model

Migration 0002 creates the following tables, now deployed to production with zero rows:

| Entity | Purpose | Required for first authenticated device read |
| --- | --- | --- |
| `devices` | Opaque device ID, installation FK, lifecycle/revocation status, credential ID/version, public key, created/revoked timestamps, and bounded pending-rotation version/deadline. Unique credential IDs. | Yes |
| `enrollment_capabilities` | Installation-bound verifier, expiry, and consumed state for one-use pairing. | Yes |
| `auth_challenges` | Device/key-version-bound nonce verifier, expiry, consumed state; delete/consume atomically on use. | Yes for replay and clock-independent authentication. |

The existing `installations`, `installation_config`, and `plan_revisions` remain. Do not add user accounts, telemetry, execution history, price snapshots, or device inventory metadata unrelated to authorization.

## 14. Implemented behavior and boundaries

Implemented locally and deployed: migration 0002; enrollment consumption (not creation); challenge issue/consume; Ed25519 signed requests; installation-scoped configuration and plan routes; key rotation; revocation storage behavior; and bounded opportunistic cleanup. Synthetic R2 remote qualification passed for enrollment, configuration read, replay/tamper rejection, installation isolation, concurrency, rotation, revocation, clock independence, and cleanup. Remote plan-payload reading remains unqualified until a legitimate demo plan exists. There are no configuration/plan writes, user/app authentication, public revoke/enrollment-create routes, hardware commands, scheduler, real credentials, or devices. Cloud still has zero real hardware authority.
