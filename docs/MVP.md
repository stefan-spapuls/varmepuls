# First working Core MVP

Phase 2B implements the Core, provider contract/normalization, strict static checking, and read-only live acquisition. The first price-to-plan MVP is proven using simulation tests and one live SE4 planning qualification, not real control or production automation. See [provider contract](PRICE_PROVIDER.md) and [live evidence](ELPRISETJUSTNU.md).

## Required capabilities and acceptance
1. Implemented: ElprisetJustNu adapter acquires spot-only SEK/kWh prices and validates quarter-hour coverage. One current SE4 live batch reached the existing planner; all automated tests remain synthetic and offline.
2. Implemented: select any SE1–SE4 explicitly; reject unknown zones and filter mixed-zone fixtures to the selected zone.
3. Normalize and validate actual 15-minute intervals as specified in ARCHITECTURE.md. Reject incomplete requested horizons, non-finite prices, gaps, duplicates, and overlaps with clear reasons.
4. Implemented: accept Summer/Winter modes. Summer requests house heating OFF; Winter requests it ON for Phase 1, without a separate authority input.
5. Schedule one fixed-duration hot-water block within the configured eligible window and horizon. Choose the lowest summed price; choose the earliest start on ties. Do not span unavailable data or invent next-day prices.
6. Produce identical output for identical input, including stable action ordering and explicit OFF at hot-water block end. No network or clock access in the planner.
7. Apply the plan through a simulated adapter that records actions without contacting devices.

## Meaningful fixture tests
Implemented tests cover every zone; negative and tied prices; contiguous-block total cost; block duration and window edges; a block ending at window end; invalid duration, timestamps, prices, and duplicated intervals; insufficient coverage; Summer/Winter behavior; repeatability; and simulation state. The explicit 10+10+10+10=40 versus 1+1+50+1=53 fixture includes a high-price separator to prevent a cheaper boundary-crossing block. Phase 1.1 adds unit conversion, mock contract, ordering, duplicate/overlap rejection, and 92/96/100-quarter UTC-window tests. Phase 2B adds actual Swedish local-day boundary resolution, provider-offset parsing, and mocked HTTP tests. Core continues accepting UTC windows only; timezone presentation remains planned.

Offline tests demonstrate both normalized fixture → planner → simulation and mock provider → source-unit conversion/validation → unchanged planner. No live source is used. No savings claim is made without measured evidence.

## Deliberate limits
No real hardware, mobile/web UI, telemetry persistence, weather, temperatures, adaptive heating, learned models, multi-day hot-water storage, or automatic season detection. Hot-water duration is an explicit input; it does not prove adequate supply, temperature, or hygiene. Multi-day production requires a future thermal model and constraints.

## Completion evidence
Run npm test with Node 24 or later; tests need no network access. Run npm run typecheck with the pinned development dependencies. Verified: 111 tests, 111 passed, 0 failed, 0 skipped; strict type check passed. Original 77 tests are preserved. Bounded live acquisition/plan evidence is recorded separately; hardware control is not implemented.
