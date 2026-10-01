# VärmePuls cloud architecture

Status: the isolated VärmePuls production Worker/D1 foundation and device-auth routes are deployed. The sole binding is VARMEPULS_STATE_DB to the VärmePuls D1 database. Synthetic R2 authentication qualification passed; remote plan-payload reading remains unqualified until a legitimate demo plan exists. No real device trusts the service, no heating system obeys it, and no Shelly is connected. Environment-specific account, database, version, deployment, and hostname identifiers are kept out of public documentation.

## 1. Goals

Keep price acquisition, planning, configuration, and history useful through a compact cloud service while ensuring safe, predictable heating does not depend on Cloudflare, internet, or the app. Cloud optimization may suggest or authorize a plan within bounds set at home. It may never become the only source of minimum heating protection.

Keep one understandable service, distinct responsibilities, unique VärmePuls resources, and low individual-user cost. Add a component only when an implemented capability needs it.

## 2. Isolation rule

VärmePuls may share a Cloudflare account with unrelated projects, but every resource and runtime identity must belong exclusively to VärmePuls. Never bind to, read, write, deploy through, or depend on another project's Workers, D1, secrets, routes, device credentials, identities, configuration, or production data. Design and verify VärmePuls from its own requirements.

Give VärmePuls its own Worker, database, bindings, secrets, device identities and credentials, state, data, and hostnames/routes when each is introduced. Use explicit VärmePuls names and separate resource IDs. Shared account ownership is administrative only; it does not imply shared runtime permissions or resources.

## 3. Responsibility boundary

| Responsibility | Cloud | Local controller | App/UI |
| --- | --- | --- | --- |
| Price acquisition and normalization | Fetch and validate published spot prices; report source freshness/errors. | Cache only validated data needed by a current authorized plan; do not invent prices. | Display price/source status. |
| Planning | Produce candidate plans and revisions within configured constraints. | Decide whether a plan is authentic, current, unexpired, and locally permissible; execute an accepted plan. | Request a plan and display it. |
| Safety and control | Publish bounded intent; no direct relay authority. | Own safety interlocks, minimum heating protection, manual local override, stale-authority behavior, and physical adapter commands. | Request user changes; never be required for autonomous operation. |
| Configuration and identity | Store synchronized desired settings and cloud account/device associations. | Keep the validated local safety envelope and enough configuration for predictable standalone operation. | Authenticate the human user and manage settings. |
| Telemetry and history | Receive authenticated observations and retain privacy-limited history. | Continue recording locally during outages and reconcile after reconnecting. | Show current state/history and connectivity. |

Cloud output is advisory or bounded authority, not a command that bypasses local policy. Loss of app connectivity does not stop the local controller. Loss of cloud connectivity does not disable locally required heating protection.

## 4. Smallest first Cloud architecture

One VärmePuls Worker is sufficient for the initial API boundary: price refresh and validation, plan generation/revisions, synchronized configuration API, and later authenticated client/device endpoints. Keep Core planning pure and platform-independent; the Worker calls the Core or a shared package and handles network/storage concerns around it.

Do not split price, planning, identity, telemetry, and history into separate services. They do not have distinct scaling, trust, or ownership needs for one household. Add separate services only after an implemented capability demonstrates such a need.

## 5. Resource naming

Use lowercase ASCII `varmepuls-<purpose>-<environment>` for resource names. Spell out `production`; do not use generic names such as `api`, `db`, or shared project names.

Proposed names:

- Worker: `varmepuls-api-production`
- D1: `varmepuls-state-production`
- Worker binding: `VARMEPULS_STATE_DB`, bound only to `varmepuls-state-production` in the production environment.
- Later nonproduction examples, only if justified: `varmepuls-api-staging`, `varmepuls-state-staging`, binding `VARMEPULS_STATE_DB` within that isolated Worker environment.
- Device identity namespace: UUID identities associated with `varmepuls` installation IDs; conceptual credential scope `varmepuls-device:<device-uuid>`. Each device gets independently revocable credentials. These are identity labels, not secrets or resources to create now.
- Future production route: a VärmePuls-owned hostname such as `api.varmepuls.example`; register no DNS or route until a real domain is selected and separately reviewed.

Do not use another project's names, resource IDs, binding names, routes, identities, or credentials in VärmePuls configuration.

## 6. Environment strategy

Development remains local, using synthetic/mock provider results and local Core/tests. The sole remote environment is the isolated Varmepuls production foundation. There is no remote development or staging environment.

Do not create staging today. Add `staging` only when a cloud change needs a remote preproduction test that local mocks cannot provide. If staging is introduced, use a separate Worker, D1, binding target, secrets, hostname, and synthetic/nonproduction data. Never point staging at production D1. Never create preview deployments against production data.

Production is configured only for the exact resources listed in this document. No other environment or production resource is implied.

## 7. Persistence decision

D1 is justified for the approved durable configuration/plan foundation because desired configuration and plan revisions must survive Worker restarts and allow a future local controller to discover the latest published revision. A memory-only Worker would lose this state. One D1 is sufficient at individual-household scale.

D1 is not needed by today's offline Core. It stores the minimum durable foundation. Phase 3D-R1 deployed the locally-qualified device-auth candidate and migration 0002 to the isolated production Worker/D1. Synthetic remote authentication was qualified in R2 and all qualification state was removed. No real device trusts Cloud; hardware authority remains zero.

## 8. Minimum conceptual data model

| Entity | Purpose | First cloud MVP? | Decision |
| --- | --- | --- | --- |
| `installation_config` | One household's desired zone, seasonal mode, schedule constraints, and configuration revision. | Yes, for synchronized configuration. | One row per installation; local safety limits remain locally authoritative. |
| `plan_revision` | Immutable plan payload/metadata, input price window/freshness, creation time, revision, expiry, and status. | Yes, if Cloud publishes executable candidate plans. | Retain current and limited recent revisions; no complex event store. |
| `installation` | Stable installation ID and lifecycle/registration state. | Yes, needed to scope configuration and plan ownership. | Minimal owner/installation association; avoid personal household detail. |
| `devices` | Per-device identity, installation FK, public key/credential version, revocation state, and pending rotation. | Migration 0002 deployed; no device rows exist. | Never store device private keys. |
| `enrollment_capabilities` | One-time installation-bound invitation verifier and consumed/expiry state. | Migration 0002 deployed; no invitation rows exist. Creation remains operator/test-only. | Never store plaintext enrollment capability. |
| `auth_challenges` | Short-lived one-use challenge nonce verifier and credential version. | Migration 0002 deployed; no challenge rows exist. | Atomic conditional consumption prevents replay. |
| `price_snapshot` | Durable copy of raw/canonical input prices for audit or reproducible planning. | No. | Phase 2B fetches on demand; add only if replay/audit or outage requirements need retention. |
| `telemetry_latest` / `execution_event` | Latest state and control outcome/history. | No. | Add after local hardware protocol, privacy retention, and reconciliation are defined. |

Keep plan inputs, immutable plan revisions, and config revision sufficient to explain a plan. Do not create tables for hypothetical scale, generic jobs, microservices, or broad event sourcing.

## 9. Plan identity, revision, and authority

Give each installation a monotonically increasing revision within a stable installation ID. A plan includes unique plan ID, installation ID, revision, creation/expiry timestamps, configuration revision, zone, exact price coverage/source timestamp, intended actions, and integrity/authentication metadata. Publish only after complete input validation.

On receipt, the local controller validates identity/authenticity, schema, installation/device scope, monotonic revision, expiry, time bounds, action bounds, configuration revision, and compatibility with its local safety envelope. A revision below the highest accepted revision is stale and rejected. An identical revision/payload is idempotent. The next valid higher revision may supersede the current one; invalid or expired data never replaces the last valid plan. Persist the highest accepted revision locally to prevent replay after reboot.

Cloud cannot remotely override local interlocks. A newer plan is not automatically safe merely because its revision is higher. Local validation can reject it and report the reason when connectivity returns. Full signing, key rotation, and wire protocol are Phase 3B+ design work, not implemented here.

## 10. Stale or unavailable price policy

Price acquisition failure means the optimizer cannot produce a new price-optimized plan. It does not mean heat must stop.

| Condition | Cloud/planner policy | Local safety policy |
| --- | --- | --- |
| Tomorrow's prices not published | Mark unavailable; do not extrapolate or fabricate. Keep existing plan only until its declared expiry and constraints permit. | Continue a still-valid accepted plan; independently protect minimum heating after expiry. |
| Temporary provider failure | Bounded retries may be considered later; report error and last successful source time. Do not silently call old prices fresh. | Do not wait for a cloud retry to provide minimum safe heating. |
| Malformed provider data | Reject the whole batch, log a privacy-conscious error, and create no plan from it. | Reject any derived invalid plan; retain local protection. |
| Missing/overlapping intervals | Reject incomplete/ambiguous coverage; no interpolation. | Do not interpret missing price as a heating-off instruction. |
| Cloud cannot refresh prices | Mark planning stale and stop issuing price-optimized revisions until valid complete data returns. | Continue local valid authority until its bound expires, then deterministic local protection. |
| Local controller cannot reach Cloud | No new remote plan is available. Cloud retains last revision/status for later sync. | Use an unexpired, authenticated cached plan within its bounds; on stale/expired/invalid authority, leave optimization and enter the locally defined protection mode. |

Exact temperature targets, duration thresholds, equipment interlocks, hygiene cycles, and physical fallback outputs depend on the future heating system and must be specified before actuation. No generic `OFF` response is safe to infer from missing price data.

## 11. Local failsafe and hardware adapter contract

Optimization is optional. Safe heating operation is mandatory.

The future local controller must operate independently of app, Internet, and Cloudflare for minimum heating protection; decide deterministically when a cached plan becomes unusable; retain manual local override and essential validated configuration; and surface faults for later synchronization. Price optimization may be disabled while the local protection policy continues.

A hardware adapter must expose actual reported state separately from desired state, make command outcomes/errors explicit, honor independent equipment interlocks, support safe local/manual authority, and document restart and communication-loss behavior. It must never claim a requested action succeeded without observation. The electrical/thermal safe state is equipment-specific; this architecture does not prescribe relay ON/OFF or temperature thresholds.

## 12. Security boundary

- Assign each installation and device a unique identity; issue separate, least-privilege credentials per device.
- Authenticate device-to-cloud and future app/user access. Scope every request to its installation/device identity and authorize each operation.
- Store only credential verifiers/public keys or secret-manager references where possible; never commit secrets or private keys to Git or expose them to the app bundle.
- Keep production secrets outside the open-source repository in the deployment secret store. Rotate credentials and revoke one device without rotating every unrelated device.
- Require TLS, validate plan freshness/revisions, prevent replay, and audit identity/config changes without logging tokens or sensitive telemetry.
- Cloud credentials must grant access only to VärmePuls resources. No unrelated-project resource binding or credential is allowed.

No device/app credentials or secrets are created. The production D1 binding is limited to the Varmepuls database named below. No device identity is enrolled.

## 13. Public source and private runtime

The public repository may contain Core, adapters, Worker source, migrations/schema, documentation, and clearly nonsecret example configuration. Public schema describes structures; it must contain no live household rows.

Private runtime state includes production secrets, device credentials/private keys, user and device records, deployed sensitive configuration, and household telemetry/history. Keep those out of Git, examples, fixtures, issues, and logs. Use synthetic fixture data in the public test suite. Do not include private information from unrelated projects.

## 14. Deferred components

No separate price or planner Worker, queue, cache service, object store, analytics service, dedicated staging environment, custom domain/route, identity provider, telemetry pipeline, history retention system, scheduler, or hardware integration is justified now. Reconsider each only when a concrete capability needs it. The deployed service exposes health plus the bounded authentication route families; synthetic remote authentication is qualified, the remote plan payload remains unqualified, and no real device is trusted.

## 15. Phase 3B resources and deployed scope

The approved minimal foundation has been created. Resource names and current qualification status are recorded in [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md); deployment-specific identifiers are intentionally omitted from public documentation.

| Resource | Name | Environment | Binding | Persistent data | Current scope |
| --- | --- | --- | --- | --- | --- |
| Cloudflare Worker | varmepuls-api-production | Production, isolated | VARMEPULS_STATE_DB only to varmepuls-state-production | No | One bounded service. Health and six device-auth route families are deployed; no config/plan mutation or device commands. Synthetic authentication is qualified; remote plan-payload reading remains unqualified. |
| Cloudflare D1 database | varmepuls-state-production | Production, isolated | Bound only to the Worker above | Yes: installations, installation configuration, immutable plan revisions | Retains the approved minimal durable state across Worker restarts. |

Exactly two Cloudflare resources exist for this foundation: one Worker and one D1. Phase 3D-R1 created no additional Cloudflare resources. Production has the three auth tables with zero rows; no devices or credentials exist. No staging resources, custom DNS/routes, secrets, queues, or additional bindings were created. No device trusts Cloud and the foundation has zero authority over heating equipment.
