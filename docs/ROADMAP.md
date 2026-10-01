# Capability roadmap

No dates are promised. Each stage depends on evidence from the preceding stage.

## Phase 0 — specification and foundation
Document normalized models, boundaries, first-MVP acceptance, and licensing recommendation. No runtime functionality.

## Phase 1 — deterministic offline Core
Implemented: minimal TypeScript models, validation, fixed-duration cheapest contiguous-block planning, Summer OFF/Winter ON heating authority, synthetic normalized price fixtures, in-memory adapter, and the original 43 focused passing tests. Node's built-in TypeScript execution and test runner require no package dependencies. Phase 1.1 adds the offline provider preparation described below. No live source is implemented.

## Phase 2 — Swedish price acquisition

Phase 1.1 preparation is implemented: strict static checking, explicit UTC-window provider contract, spot-only SEK/kWh meaning, offline unit normalization, and normal/spring/autumn market-window tests. The full offline suite has 77 passing tests. Local-date resolution, live-source field mapping, transport, retries, and caching remain planned.
Phase 2B implemented: ElprisetJustNu read-only adapter, source-offset mapping, Swedish local-date UTC boundaries, explicit failures, injected HTTP tests, and one SE4 live qualification reaching the unchanged planner. All 111 offline tests and strict checking pass. Retries/caching, persistent storage, daily scheduling, and production operation remain planned; simulation remains independent of hardware.

## Phase 3 — safe integration and observations
Define equipment-specific constraints, manual override, stale-data behavior, independent interlocks, and hot-water hygiene policy before actuation. Add normalized telemetry and optional historical storage. Evaluate Home Assistant, Shelly, other relays, heat pumps, electric boilers, and immersion heaters behind adapters. Any hardware testing requires a separate explicitly authorized task.

## Phase 4 — constrained thermal scheduling
Add user comfort targets, hot-water thermal model, thermal inertia estimation, and evaluation of producing hot water for multiple days. Evaluate cheap-period pre-heating and expensive-period avoidance only within validated comfort and equipment constraints.

## Phase 5 — adaptive house heating
After deterministic Core works, evaluate outdoor and indoor temperatures, room/radiator sensors, Tado or similar integrations, weather forecasts, learned house heat-loss models, predictive heating, and adaptive heating curves. Compare outcomes against simple baselines before granting control authority.

## Phase 6 — usability and resilience
Consider mobile/web clients, local autonomous operation, recovery after outages, and privacy-conscious historical telemetry. Keep clients and deployment infrastructure separate from planning Core.
