# ElprisetJustNu adapter — Phase 2B

Implemented in src/adapters/elprisetjustnu.ts. Prices supplied by [ElprisetJustNu](https://www.elprisetjustnu.se); see its [official API documentation](https://www.elprisetjustnu.se/elpris-api).

## Architecture and usage
ElprisetJustNuAdapter.getPrices({ zone, date }) takes SE1–SE4 and a real YYYY-MM-DD Swedish calendar date. It constructs only this fixed endpoint:

`https://www.elprisetjustnu.se/api/v1/prices/[YEAR]/[MM]-[DD]_[ZONE].json`

Input validation prevents arbitrary path/host substitution. Node's native fetch is the default transport; tests inject a fetch function. Redirects are rejected. The default timeout is 10 seconds and bounds fetch plus JSON body reading. No new dependencies were added.

The adapter maps SEK_per_kWh directly into spot-only Core prices, without taxes or additions. EUR_per_kWh and EXR are unused. Shape, finite numeric prices, timestamps, interval lengths, ordering, overlap/duplicate checks, and complete coverage are enforced by adapter mapping plus the existing normalizePrices function. The provider response carries no zone field; the requested zone is supplied from the validated endpoint. Core and planner behavior are unchanged.

The provider documents quarter-hour observations from 2025-10-01; older hourly observations fail interval validation. There is no hourly-to-quarter expansion. Tomorrow data may not yet be published; callers receive explicit unavailability rather than stale or fabricated prices.

## Time boundary
stockholmDayWindow resolves the requested local midnight and the following local midnight independently using Node Intl's Europe/Stockholm rules. Their UTC distance determines coverage: normal 96, spring 92, autumn 100 quarters. No fixed-96 assumption is imposed.

Provider timestamp offsets are authoritative. Explicit ISO offsets or Z are parsed to UTC after strict calendar validation; missing offsets, malformed dates, nonzero subsecond values, and invalid offsets are rejected. Repeated autumn wall-clock times with different offsets remain distinct instants. Existing UTC normalization then requires aligned exact 15-minute intervals and full day coverage. The adapter does not alter timestamps to fit an expected day.

## Failure behavior
- INVALID_REQUEST: invalid date or zone; no fetch.
- UNAVAILABLE: HTTP 404.
- HTTP_ERROR: other non-2xx status.
- NETWORK_ERROR: failed transport, including rejected redirect.
- MALFORMED_JSON: unreadable JSON body.
- TIMEOUT: deadline exceeded; request aborted.
- Existing normalization failures: invalid records/prices/intervals, duplicates, overlaps, out-of-window data, or missing coverage.

Every failure has a reason and no usable batch. No automatic retries, cache, stale reuse, or fallback prices exist.

## Offline validation
All original 77 tests are preserved. 34 new tests cover valid and invalid responses, negative/zero values, source timestamp offsets, hourly rejection, duplicates, gaps, overlap, HTTP failures, timeout (including body read), deterministic mapping, safe URLs, and actual local-date-to-UTC resolution for normal/spring/autumn dates.

Run npm test and npm run typecheck. Verified: 111 tests, 111 passed, 0 failed, 0 skipped; strict TypeScript passed. Automated tests use injected transports and make no real requests.

## One bounded live qualification
Performed after offline tests and type checking passed, using one read-only price GET. No complete provider payload was saved in documentation.

- Requested date: 2026-10-01, Europe/Stockholm.
- Zone: SE4.
- Endpoint: https://www.elprisetjustnu.se/api/v1/prices/2026/10-01_SE4.json
- HTTP: 200.
- Received and normalized intervals: 96, each exactly 15 minutes.
- UTC coverage: [2026-09-30T22:00:00.000Z, 2026-10-01T22:00:00.000Z).
- Minimum: 1.05836 SEK/kWh.
- Maximum: 3.01507 SEK/kWh.
- Existing planner input: Summer, synthetic required runtime 60 minutes, complete day window.
- Selected block: [2026-09-30T23:45:00.000Z, 2026-10-01T00:45:00.000Z), four contiguous quarters.
- Stockholm equivalent: 2026-10-01 01:45–02:45.
- priceSumSekPerKwh: 4.7778, the sum of four six-decimal normalized interval prices. This is a comparison metric, not monetary expenditure; actual cost needs consumption.

These are observations from one qualification, not fixtures or promises of future prices. The logical plan was inspected only; no device adapter or hardware action was executed.

## Deliberate limits
No daily scheduler, retries/caching, persistent storage, hardware control, UI, telemetry, adaptive heating, deployment, or consumer total-cost model. This adapter performs acquisition only when explicitly called. Future production behavior requires a separate task.
