# VärmePuls Cloud deployment notes

This document describes the current VärmePuls-only Cloud foundation without recording account IDs, database IDs, deployment/version IDs, hostnames, or credentials. The local production Wrangler file is ignored by Git; see [`wrangler.example.jsonc`](../wrangler.example.jsonc) for a safe development template.

## Current state

- One production API Worker and one production D1 database exist, with the sole binding `VARMEPULS_STATE_DB` pointing to that VärmePuls database.
- Migrations `0001_initial.sql` and `0002_device_auth.sql` are applied.
- Health and six bounded device-authentication route families are deployed. There is no public enrollment-creation or revocation route, no configuration/plan mutation API, arbitrary SQL endpoint, hardware command, or automatic scheduler.
- Phase 3D-R2 synthetic remote qualification passed enrollment single-use, Ed25519 authentication, challenge replay rejection, tamper rejection, installation isolation, concurrent challenge consumption, rotation, revocation, cleanup, and controller-clock independence.
- The remote plan route exists, but its payload/scoped plan read remains unqualified until a legitimate demo plan is available. Plan immutability will not be weakened for a disposable test.
- No real device is enrolled, no real device credential exists, and Cloud has zero real hardware authority.

The exact Worker and D1 names follow the `varmepuls-*` namespace. Environment-specific identifiers belong in private deployment configuration and are intentionally omitted from this public documentation.

## Deployed API and schema

The public health routes are `GET /health` and `HEAD /health`. The device-auth route families are:

- `POST /v1/enrollments/consume`
- `POST /v1/device/challenges`
- `GET /v1/device/config`
- `GET /v1/device/plan`
- `POST /v1/device/rotation`
- `POST /v1/device/rotation/confirm`

These routes do not provide app/user authentication, invitation creation, revocation, configuration mutation, plan mutation, or device control. Authenticated plan delivery does not require a future local controller to execute a plan; local safety validation remains mandatory.

Migration `0001_initial.sql` creates the installation, installation configuration, and immutable plan revision tables. Migration `0002_device_auth.sql` adds device identities, one-time enrollment capabilities, and short-lived authentication challenges. D1 migration bookkeeping is platform-managed. There are no telemetry-history, price-snapshot, billing, analytics, or execution-event tables.

Configuration writes use an expected-revision compare-and-set guard. Plan revisions are append-only, monotonically ordered per installation, linked to a configuration revision, and immutable. Authentication derives installation scope from the authenticated device record, not a caller-supplied installation ID.

## Security and operating boundaries

Production currently has no real installation/device credentials or trusted controller. The remote R2 qualification used only synthetic state and removed it afterward. No secrets, cron triggers, custom routes, or auxiliary Cloud resources are part of this foundation.

This repository contains a development Wrangler template only. Before any future remote operation, create or select dedicated VärmePuls resources, place their IDs in local ignored configuration, and independently verify the exact target. Never commit the local Wrangler configuration or production identifiers. Do not run deployment or migration commands as part of local development.

No physical controller, relay, boiler, or heating system has been connected. The Cloud foundation is not an equipment-safety mechanism and must not be treated as one.

## Earlier foundation qualification

The first Cloud foundation used a clearly synthetic installation to verify configuration creation, compare-and-set revision updates, conflict behavior, and cleanup. Later R1 deployed the auth candidate and applied migration 0002; R2 qualified bounded synthetic authentication behavior. These records contain no production identifiers or household information. See [Cloud architecture](CLOUD_ARCHITECTURE.md), [authentication design](AUTHENTICATION.md), and [R1 deployment record](PHASE_3D_R1_DEPLOYMENT.md).
