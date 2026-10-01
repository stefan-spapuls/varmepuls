# Authentication feasibility evidence - Phase 3C.1 and Phase 3D-local

Status: this document records Phase 3C.1 primitive feasibility and subsequent local implementation evidence. The implementation and migration 0002 are deployed. Synthetic Phase 3D-R2 qualification remotely proved enrollment single-use, Ed25519 authentication, challenge replay/tamper rejection, installation isolation, concurrent challenge consumption, rotation, revocation, cleanup, and controller-clock independence. No real credential or hardware connection exists. Remote plan-payload reading remains unqualified until a legitimate demo plan is available. See [local qualification](AUTHENTICATION_LOCAL_QUALIFICATION.md) and [current deployment notes](CLOUD_DEPLOYMENT.md).

## A. Ed25519 in the Worker runtime

The proof ran in the local Workers runtime/toolchain pinned by this repository:

- Wrangler `4.145.0`
- Miniflare `5.20260930.0-alpha`
- workerd `1.20260930.2`
- Worker compatibility date `2026-09-30`, matching `wrangler.jsonc`

The temporary in-process test Worker used the standard Web Crypto calls:

```js
const key = await crypto.subtle.importKey(
  "raw", rawPublicKey, { name: "Ed25519" }, false, ["verify"]
);
const valid = await crypto.subtle.verify(
  { name: "Ed25519" }, key, signature, message
);
```

Signing occurred outside workerd with Node's standard Ed25519 signer using the published RFC 8032 test vector seed. That seed is public test material, not a production key. The workerd-side verifier accepted the RFC 8032 empty-message signature and a separately signed canonical request. It rejected a changed message, a changed signature, and the valid signature under a different valid Ed25519 public key. No custom cryptography was used.

This establishes that the exact locally pinned workerd runtime accepts the selected Web Crypto API. The later bounded R2 qualification also exercised signed requests against the deployed Worker. Cloudflare's [Workers Web Crypto documentation](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) lists Ed25519 `importKey`, `verify`, and `sign` support.

## Canonical signed request representation

`src/security/canonical-request.ts` defines the tested format. It is a binary, length-prefixed encoding, not delimiter concatenation or JSON:

1. Four fixed magic bytes: ASCII `VPDA`.
2. A two-byte unsigned big-endian field count, currently 8.
3. For each field in the fixed order below: four-byte unsigned big-endian UTF-8 byte length, then those bytes.

The exact field order is:

1. protocol version (`varmepuls-device-auth-v1`)
2. device ID
3. credential/key ID
4. challenge ID
5. server nonce in canonical base64url form
6. uppercase HTTP method
7. normalized path
8. lowercase hexadecimal SHA-256 digest of the exact raw request body

For this initial route family, authenticated paths have no query string. The encoder rejects query/fragment delimiters, percent escapes, backslashes, duplicate slashes, dot segments, non-ASCII path characters, and non-uppercase methods. If authenticated query parameters are later needed, they must be added as a separately specified canonical field; they must not be silently omitted.

The test signs the baseline encoding outside workerd and verifies inside workerd. Changing protocol version, device ID, credential ID, challenge ID, nonce, method, path, or body digest makes verification fail. A boundary-collision test confirms that different field splits do not produce the same encoding. The body digest uses standard SHA-256; production should compute it with `crypto.subtle.digest("SHA-256", rawBody)`.

## B. Atomic challenge compare-and-consume

`src/security/challenge-consume.ts` contains the exact tested conditional write. The request signature must first be verified against the selected challenge. Only then call this operation. The SQL itself rechecks challenge identity, nonce digest, device, credential and key version, unused state, and expiry:

```sql
UPDATE auth_challenges
SET consumed_at = ?
WHERE challenge_id = ?
  AND nonce_sha256 = ?
  AND device_id = ?
  AND credential_id = ?
  AND credential_version = ?
  AND consumed_at IS NULL
  AND expires_at > ?;
```

Bind both time parameters to the same trusted `serverNowUtc` value. Generate it in the Worker immediately before the statement with `new Date().toISOString()`; never accept it from a controller. Store timestamps in fixed-width UTC ISO format so their lexical ordering agrees with time ordering. The update is one conditional SQL statement. Treat `meta.changes === 1` as consumed and every other result as rejection. Do not rely on a prior `SELECT` to guarantee one-use: a lookup is needed to obtain the nonce for signature verification, but only this final conditional update decides the race.

An `auth_challenges` table should also have a trigger that prevents a non-null `consumed_at` from being set back to null. Replaying a consumed challenge then changes zero rows; explicitly reopening it is rejected by the trigger.

## Local D1-compatible evidence

The feasibility test starts a local Miniflare Worker with a local D1 binding, creates only an in-memory/local test table, and runs the same SQL helper. It does not load or apply a repository migration and does not connect to production. Results:

- first matching, unexpired consumption: one row changed, success;
- second use: zero rows changed, rejection;
- exact expiry boundary: zero rows changed, rejection;
- wrong nonce digest, device, credential, key version, or unknown challenge: zero rows changed;
- malformed challenge ID/hash: rejected before SQL;
- consumed-to-unused update: trigger rejection;
- two `Promise.all` competing local D1 consumers: exactly one success and one rejection.

The model is actual SQLite/D1-compatible conditional-update behavior under local workerd/Miniflare, not a production D1 concurrency experiment. Cloudflare describes D1 as auto-commit and SQLite-compatible; see the official [D1 binding and transaction documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [SQL statement documentation](https://developers.cloudflare.com/d1/sql-api/sql-statements/). This evidence supports the single-statement design but does not claim cross-region production consistency, failover behavior, or revocation read freshness. Those require a separately authorized nonproduction Cloud D1 qualification before production authentication is enabled.

## Server time and challenge lifetime

The controller clock is absent from the signed fields and SQL parameters. Cloud time is authoritative for both challenge creation and consumption. A rebooted controller with an incorrect wall clock can request a fresh challenge and sign its nonce; it need not set or trust its clock first.

Recommended challenge lifetime: **120 seconds**. It is separate from the five-minute enrollment invitation. Two minutes gives ordinary request/sign/submit flows room for network delay and device scheduling while keeping replay material short-lived. The server rejects at `expires_at <= serverNowUtc`.

## Challenge storage and abuse controls

- Persist challenges only for active, known device/key selectors; return no installation data from challenge creation.
- Enforce at most three unconsumed challenges per device/key version. Do not silently invalidate earlier challenges to satisfy the cap.
- Apply a small edge/Worker rate limit by source address and by device/key selector (initial proposal: 10 challenge requests per minute for either dimension). Return a generic error for unknown, revoked, and rate-limited selectors.
- Index expiry and opportunistically delete expired or consumed rows in bounded batches during rate-limited challenge creation. If volume later justifies it, add a bounded cleanup schedule in a separately reviewed phase; none exists now.
- Expiry plus the per-device cap bound retained live rows; rate limits constrain request amplification. Do not build a general-purpose rate-limiting service for this single-controller use case.

## Rotation stress review

The Phase 3C proposal to expire both keys after an unconfirmed rotation could unnecessarily strand a legitimate controller after a temporary outage. The policy model and `docs/AUTHENTICATION.md` are corrected:

- The old confirmed key remains the only fully authorized key during rotation; the pending new key may only confirm.
- If the new key confirms within ten minutes, promote it and invalidate the old key immediately.
- If confirmation does not arrive by the deadline, discard only the pending key and keep the old key active. The controller can retry rotation without pairing again.
- If the old key is lost or suspected compromised, explicitly revoke and re-pair. A confirmed rotation response lost in transit is recoverable because the controller generated and retained the new key before submission; it retries with that key.

This gives a bounded dual-key interval and deterministic recovery without treating a transient connectivity failure as credential loss. The old key remains exposed until successful confirmation or explicit revocation, which is the deliberate availability tradeoff.

## Test and production boundary

The Phase 3C.1 suite contained 145 baseline tests plus 20 feasibility tests: **165 passed, 0 failed, 0 skipped**. Phase 3D-local added 22 tests, bringing the current suite to **187 passed, 0 failed, 0 skipped**. Core and Worker TypeScript checks pass. All automated tests run locally and require no production network.

Historical Phase 3C.1 result: at that time no production routes or Worker code had changed and only migration 0001 was applied. Later phases deployed migration 0002 and the reviewed Worker candidate. R2 remotely qualified synthetic authentication behavior and removed its synthetic state. No real credentials, devices, or hardware connections exist.

Remaining uncertainty: remote plan-payload delivery has not been qualified because no legitimate persistent demo plan exists. No real controller is trusted; authentication does not give Cloud hardware authority or replace local safety validation.
