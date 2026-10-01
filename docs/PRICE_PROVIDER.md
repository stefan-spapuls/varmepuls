# Offline price-provider contract

Phase 1.1 implemented this provider interface, synthetic offline provider, unit conversion, and all-or-nothing normalization. Phase 2B adds a separate [ElprisetJustNu adapter](ELPRISETJUSTNU.md) that resolves Swedish dates, reads live HTTP data, and feeds this unchanged UTC contract. Credentials, retries, caching, and production operation remain unimplemented.

## Boundary
External source → future provider-specific field/unit/time mapping → normalizePrices → normalized batch → unchanged Core planner.

The contract and normalizer live in src/adapters/price-provider.ts. Core has no source fields, source units, URLs, HTTP, authentication, or provider response types. SourcePriceInterval is a generic adapter-side record with unknown-valued startUtc, endUtc, zone, and value fields; an eventual adapter maps its actual source format into these fields. No actual provider format is assumed.

## Request and result
PriceProvider.getPrices(request) accepts { zone, window: { startUtc, endUtc } }. Zone is SE1, SE2, SE3, or SE4; the request is a half-open, increasing UTC window with quarter-hour boundaries. It may represent any complete requested window, not just a fixed 24-hour day.

Success returns { ok: true, batch }, with requested zone, canonical UTC window, unit: "SEK/kWh", costBasis: "spot-energy-only", and readonly normalized Core intervals. Failure returns { ok: false, code, reason }, with no batch or partial usable data. OfflinePriceProvider implements this interface against a copied synthetic source; repeated calls produce fresh independent normalized results.

## Canonical price meaning
Core priceSekPerKwh means Swedish kronor per kilowatt-hour of spot energy only. It excludes VAT, taxes, network charges, retail markup, and other customer costs. Negative prices and zero are valid. This is not a final electricity bill.

Implemented source units are SEK/kWh (identity) and SEK/MWh (divide by 1000). The source unit must be explicit; unsupported units and nonnumeric/nonfinite values are rejected. No currency conversion or implicit tax removal occurs. A future live adapter must verify its published unit and price basis before mapping data; it must reject an incompatible basis instead of labeling it spot-only.

Conversion uses finite IEEE-754 numbers and preserves available precision. The planner retains its existing six-decimal micro-SEK/kWh rounding for comparisons. Values outside that Core safe-integer scaled range are rejected. Decimal conversion tests allow only machine-epsilon division differences. There is no additional provider-side pricing-rounding policy.

## Normalized acceptance criteria
- Every record matches the requested zone; unlike the planner's mixed-zone fixture support, a provider batch contains only the requested zone.
- UTC timestamps use Z and real calendar dates, with optional .000 seconds fraction. Offset timestamps must be converted before this normalizer.
- Every interval is aligned and exactly 900 seconds, half-open [start, end).
- Source ordering may vary; normalization returns chronological order without modifying source data.
- Duplicates, overlaps, out-of-window records, invalid prices, and invalid intervals cause explicit rejection.
- Coverage must exactly fill the requested window. A missing quarter rejects the whole batch; no interpolation, extrapolation, hourly expansion, or fabricated prices.
- A future adapter may select the requested window from a larger response before normalization; normalization itself rejects excess records.

## UTC and Europe/Stockholm responsibility
The application/request boundary or future provider adapter resolves a Swedish local calendar date to midnight in Europe/Stockholm and the next local midnight, then supplies those instants as UTC. The next local midnight is determined in that timezone, not by adding 24 hours to the first UTC instant. The provider-specific mapping also resolves source local times and offsets, including ambiguous repeated autumn times; it must reject timestamps that cannot be resolved unambiguously.

The generic normalizer validates explicit UTC timestamps and has no timezone conversion API. The Phase 2B adapter now implements Swedish local-date boundary resolution and source-offset conversion upstream of this normalizer. The Core stays in UTC and never needs local dates or DST rules. No timezone presentation UI is added.

Offline fixtures verify these boundaries with Node Intl's Europe/Stockholm timezone data:

| Local market date | UTC start | UTC end | Hours | Quarters |
| --- | --- | --- | --- | --- |
| 2026-01-15 | 2026-01-14T23:00:00Z | 2026-01-15T23:00:00Z | 24 | 96 |
| 2026-03-29 | 2026-03-28T23:00:00Z | 2026-03-29T22:00:00Z | 23 | 92 |
| 2026-10-25 | 2026-10-24T22:00:00Z | 2026-10-25T23:00:00Z | 25 | 100 |

Expected coverage is calculated from actual request boundaries divided by 900 seconds. There is no requirement for exactly 96 records. Spring has no invented local-hour prices; autumn repeated local hours remain distinct UTC intervals. Phase 2B separately tests live-source mapping and local-date resolution with mocked HTTP responses.

## Static checking and offline verification
Run npm run typecheck and npm test with Node 24+. TypeScript 5.9.3 and @types/node 25.9.8 are pinned development-only dependencies; undici-types 7.24.6 is a transitive declarations dependency. None is used by runtime planning or tests. tsconfig enables strict checking, exact optional properties, unused declarations/parameters checks, NodeNext resolution, erasable syntax, and no emit. All source and tests are checked; library checks are enabled.

The dependencies were installed from local cache using --offline --ignore-scripts --no-audit --no-fund, and package-lock.json records versions and integrity. A fresh machine needs these packages provisioned to type-check; network access is unnecessary when they are cached. Tests themselves run directly without installed packages:

```sh
node --test tests/planner.test.ts tests/price-provider.test.ts tests/elprisetjustnu.test.ts
```

Phase 1.1 baseline: 77 tests passed (43 planner plus 34 provider/normalization). Phase 2B adds 34 adapter tests: 111 total, 111 passed, 0 failed, 0 skipped; type check passes. Original test expectations and Core behavior are unchanged.
