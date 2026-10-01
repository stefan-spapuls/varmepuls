# Phase 3D-R1 production deployment record

Status: PASS for the narrowly authorized structural deployment. This historical record omits account IDs, D1 IDs, Worker version/deployment IDs, hostnames, secrets, and household details.

## Pre-deployment state

The VärmePuls production API Worker and D1 database were checked read-only. The Worker was on its earlier health-only version, its sole binding targeted the VärmePuls production database, migration `0001_initial.sql` was applied, and `0002_device_auth.sql` was pending. The three original application tables existed; no authentication tables or authentication rows existed. The health endpoint returned HTTP 200.

## Authorized deployment outcome

- Migration `0002_device_auth.sql` was applied only to the VärmePuls production D1 database. It added `devices`, `enrollment_capabilities`, and `auth_challenges` without changing the original installation, configuration, or plan tables.
- The reviewed device-auth Worker candidate was deployed only to the VärmePuls production API Worker. Its only D1 binding remained `VARMEPULS_STATE_DB` to the VärmePuls production database.
- The production migration set became `0001_initial.sql` and `0002_device_auth.sql`.
- `GET /health` and `HEAD /health` returned HTTP 200 after deployment. No authentication route was qualified during R1.
- The three authentication tables contained zero rows. No enrollment, device, challenge, credential, or qualification state was created.
- No secrets, additional resources, bindings, routes, cron triggers, or scheduled work were created. No rollback occurred.

## Later qualification and current boundary

Phase 3D-R2 subsequently qualified synthetic remote enrollment, Ed25519 authentication, replay/tamper rejection, installation isolation, concurrent challenge consumption, rotation, revocation, cleanup, and controller-clock independence. All synthetic state was removed. Remote plan-payload reading remains unqualified until a legitimate persistent demo plan exists; immutable plan behavior was not weakened to create disposable test state.

No real device or credential exists, no hardware has been paired, and the Cloud foundation has zero authority over heating equipment. See [current Cloud deployment notes](CLOUD_DEPLOYMENT.md) and [authentication design](AUTHENTICATION.md).
