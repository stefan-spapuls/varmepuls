# VärmePuls documentation

Start with the [project README](../README.md) for the current status, quick start, and hardware-free demo. The guides below are grouped so developers can understand the design and run the project without reading historical qualification records first.

## Design and architecture

- [System architecture](ARCHITECTURE.md) — boundaries between price providers, Core planning, and adapters.
- [Cloud architecture](CLOUD_ARCHITECTURE.md) — Cloud/local/app responsibilities, isolation, persistence, and safety boundaries.
- [Authentication design](AUTHENTICATION.md) — device identity, enrollment, request authentication, authorization, rotation, and known limits.
- [MVP scope](MVP.md) — current Core scope and explicit exclusions.

## Implementation and developer guides

- [Price-provider contract](PRICE_PROVIDER.md) — normalized price data and validation rules.
- [ElprisetJustNu adapter](ELPRISETJUSTNU.md) — live provider behavior and data semantics.
- [Hardware-free simulator](SIMULATOR.md) — deterministic virtual household, assumptions, demo scenarios, and limitations.
- [Cloud deployment notes](CLOUD_DEPLOYMENT.md) — current deployed routes, schema, and operating boundary; deployment is not part of ordinary local development.
- [Contributing](../CONTRIBUTING.md) — setup and contribution expectations.
- [Security policy](../SECURITY.md) — security scope and private-reporting limitation before publication.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — Contributor Covenant and unresolved enforcement contact.

## Qualification and evidence

These documents record phase-specific evidence and are not required for a first local run:

- [Authentication feasibility](AUTHENTICATION_FEASIBILITY.md) — runtime, request-signing, and challenge-consumption evidence.
- [Local authentication qualification](AUTHENTICATION_LOCAL_QUALIFICATION.md) — synthetic local Worker/D1 tests.
- [Phase 3D-R1 deployment record](PHASE_3D_R1_DEPLOYMENT.md) — historical structural deployment evidence.
- [Public release checklist](PUBLIC_RELEASE_CHECKLIST.md) — work complete locally and checks still required at publication.

## Roadmap

- [Project roadmap](ROADMAP.md) — planned work and deferred capabilities. Roadmap items are not implemented features.
