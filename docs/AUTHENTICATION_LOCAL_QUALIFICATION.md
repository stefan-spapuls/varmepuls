# Device authentication qualification

This document records the Phase 3D-local end-to-end qualification of the authentication implementation. The actual Worker route module ran in local Miniflare/workerd with local D1 and synthetic installations. The local phase did not contact production. Later deployment and remote qualification status is maintained in [Cloud deployment notes](CLOUD_DEPLOYMENT.md).

## Local implementation

The Worker implements these device-authentication routes:

- `POST /v1/enrollments/consume`
- `POST /v1/device/challenges`
- `GET /v1/device/config`
- `GET /v1/device/plan`
- `POST /v1/device/rotation`
- `POST /v1/device/rotation/confirm`

Enrollment creation and public revocation are deliberately absent. Synthetic invitation verifiers and revocation state are created only through bounded test setup in local D1. No configuration or plan mutation, telemetry, device command, automatic planner, cron, or scheduler is part of this implementation.

Migration `0002_device_auth.sql` adds `devices`, `enrollment_capabilities`, and `auth_challenges` with installation foreign keys, lifecycle checks, indexes, and guards against reopening consumed invitation/challenge state. Cloud stores only Ed25519 public keys and credential metadata. Enrollment capabilities are stored as domain-separated SHA-256 verifiers; plaintext capabilities and private keys are not stored.

Enrollment consumes a valid installation-bound invitation once and returns opaque device and credential IDs. Challenges last 120 seconds, bind to an active device/key version, and are limited to three outstanding per device/key version. Signed requests bind protocol, device, credential, challenge, server nonce, method, path, and the SHA-256 digest of exact body bytes. Web Crypto Ed25519 verification precedes atomic conditional challenge consumption. Server time controls expiry; controller time is not used.

Configuration and plan reads derive installation scope from the authenticated device record. Plan responses carry metadata for future local validation and do not contain hardware-specific commands. Rotation retains the confirmed key while the pending key is restricted to confirmation for ten minutes. Successful confirmation promotes the new key and invalidates the old one; timeout clears only pending state. Cleanup is bounded and opportunistic.

## Offline end-to-end evidence

The suite at that phase contained 187 tests: **187 passed, 0 failed, 0 skipped**. Strict Core and Worker TypeScript checks passed. Coverage included:

- schema constraints and absence of private-key columns;
- valid, expired, wrong-installation, malformed-key, and replayed enrollment;
- unique device identities and installation binding;
- challenge issuance, expiry, unknown/revoked selectors, and the three-challenge cap;
- signed configuration/plan reads and cross-installation isolation;
- signature, method, path, and body tampering;
- challenge replay and competing local consumers;
- key rotation, timeout recovery, revocation, and incorrect controller clock;
- bounded cleanup preserving installation/configuration/plan/device state.

Automated tests are offline and use synthetic keys. The 187-test count is the historical Phase 3D-local result; current repository checks may include additional tests. Current remote qualification evidence and remaining limitations are described in [Cloud deployment notes](CLOUD_DEPLOYMENT.md) and [authentication design](AUTHENTICATION.md).

## Safety boundary

No physical controller or real credential was used for local qualification. Authentication identifies and scopes a device; it does not make a Cloud plan safe to execute. A future local controller must independently validate installation identity, revisions, validity, coverage, action bounds, and local safety constraints. Current hardware authority remains zero.
