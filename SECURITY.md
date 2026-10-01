# Security Policy

## System and scope

VärmePuls contains a deterministic planning Core, electricity-price adapters, an isolated Cloud Worker/D1 foundation, device-authentication code, and an offline virtual-house simulator. The deployed Cloud foundation exposes health and bounded device-authentication routes. Synthetic remote authentication passed bounded qualification; remote plan-payload reading is still awaiting qualification with a legitimate demo plan.

No real controller is paired, no real device credential exists, and the Cloud service has zero authority over heating equipment. The simulator does not contact hardware. This policy covers all repository source, tests, migrations, documentation, examples, build/dependency configuration, and the deployed VärmePuls service.

## Threat model and trust boundaries

Treat price-provider responses, HTTP requests, stored configuration and plans, imported fixtures, and device-supplied data as untrusted. Important boundaries include external price data to normalization, callers to Worker routes, authenticated device identity to installation-scoped storage, Cloud plans to future local controllers, and test/example data to public source.

The system must preserve installation isolation, per-device identity, authentication and authorization separation, one-time enrollment/challenge behavior, revocation and rotation semantics, bounded parsing, and fail-closed handling of malformed or incomplete price/plan data. A future local controller must remain the final equipment-safety boundary; Cloud authentication does not make a plan physically safe.

## Reportable issues

Please report issues that could realistically cause or enable:

- authentication or authorization bypass, replay, or cross-device/cross-installation access;
- exposure of device private keys, enrollment capabilities, production credentials, household data, or sensitive deployment configuration;
- unauthorized changes to configuration or plans, tampering with plan authority/revisions, or unsafe future equipment commands;
- exploitable request parsing, injection, dependency, build, or supply-chain weaknesses affecting this project;
- leakage of private household information through responses, logs, tests, fixtures, or repository history.

Include affected component/version, impact, conditions required, and a minimal reproducible description. Use synthetic identifiers and data. Do not include real credentials, private keys, household details, or a weaponized exploit beyond what is needed to explain the issue.

## Private disclosure

Please report security-sensitive vulnerabilities privately to [stefan@spapuls.se](mailto:stefan@spapuls.se). Do not post vulnerability details in public issues, discussions, or social posts. Use synthetic identifiers and data, and do not include real credentials, private keys, household details, or more exploit detail than needed to explain the issue.

Please allow maintainers time to investigate and coordinate a fix before public disclosure. No response-time or bounty commitment is made by this policy.

## Known limitations

There is no real hardware integration or real-device credential to assess today. Cloud authentication has only been exercised with synthetic identities; the remote plan payload has not yet been qualified. The virtual thermal model is illustrative and is not a safety specification. These limitations do not make a demonstrated weakness in the existing code out of scope.
