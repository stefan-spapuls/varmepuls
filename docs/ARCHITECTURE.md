# Architecture

Phase 2B adds [ElprisetJustNu](ELPRISETJUSTNU.md) exclusively in adapters: Swedish date → UTC window, source JSON/offset mapping → existing normalizePrices → unchanged Core intervals and planner. HTTP and source field names remain outside Core. Live acquisition is explicit and read-only; scheduling and device execution are not added.

## Scope and data flow
PriceProvider → normalized 15-minute intervals → Planner → desired actions → DeviceAdapter → device.
TelemetryAdapter → normalized observations → future Core inputs.

Phase 1.1 implements normalized types, a pure hot-water planner, an in-memory device adapter, and an offline provider/normalization contract. PriceProvider is defined in src/adapters/price-provider.ts; see [provider contract](PRICE_PROVIDER.md). TelemetryAdapter below remains a proposed future contract. PriceInterval, Mode, DesiredAction, and DeviceAdapter are implemented in src/core/models.ts. Core has no networking, storage, wall-clock reads, device identifiers, or provider-specific payloads.

## Normalized price model (Core)
- Zone: SE1 | SE2 | SE3 | SE4.
- Interval: zone, startUtc, endUtc, priceSekPerKwh.
- UTC timestamps use ISO 8601 with Z; intervals are half-open [start, end), exactly 900 seconds, aligned to quarter-hours.
- Prices are finite numbers in SEK/kWh, may be negative, and use a declared consistent cost basis. MVP uses spot energy price only, excluding tax, VAT, network fees, and markup; this is not the customer's total bill.
- The planner accepts mixed-zone synthetic input, filters the selected zone, and sorts a copy without changing caller input. Unknown zones are rejected. Selected-zone records must be valid, unique, and non-overlapping, including records outside the window. The selected zone must cover the entire window without gaps; other supported zones are not used for scheduling. The offline provider normalizer is stricter: every record must match the requested zone and window. Its batch declares canonical unit and spot-only basis. Retrieval metadata remains future work. Do not interpolate missing prices or silently turn hourly prices into quarter-hour prices.
- Use Europe/Stockholm for local day boundaries and display, UTC for calculation. A local day may contain 92, 96, or 100 intervals at daylight-saving transitions.

## Minimal extension points
```ts
type Zone = "SE1" | "SE2" | "SE3" | "SE4";
type Mode = "summer" | "winter";
interface PriceInterval {
  zone: Zone;
  startUtc: string;
  endUtc: string;
  priceSekPerKwh: number;
}
// PriceProvider now lives in adapters/price-provider.ts:
// getPrices({ zone, window }): Promise<PriceProviderResult>.
// Success wraps Core intervals with canonical unit, basis, and request boundary;
// failure has a reason and no partial batch. See PRICE_PROVIDER.md.
interface DesiredAction {
  atUtc: string;
  target: "domestic-hot-water" | "house-heating";
  enabled: boolean;
}
interface DeviceAdapter {
  apply(action: DesiredAction): Promise<void>;
}
interface Observation {
  atUtc: string;
  target: DesiredAction["target"];
  enabled: boolean | null;
}
interface TelemetryAdapter {
  read(): Promise<readonly Observation[]>;
}
```

PriceProvider and adapters are infrastructure ports; their implementations belong in src/adapters. Shared normalized types and the pure Planner belong in src/core. Provider implementations must enforce the documented normalization contract. Telemetry is an extension point only and is not required by the first planner.

## Planner and modes (Core)
Implemented API: planHotWater({ prices, zone, mode, runtimeMinutes, window }). The permitted window is also the planning horizon. Its UTC boundaries must align to quarter-hours; runtime must be a positive integer multiple of 15 minutes. There is no separate Winter heating request in Phase 1. The result is either { ok: true, block, actions } or { ok: false, code, reason, actions: [] }. No implicit current time or random choices.

MVP hot water is one contiguous block of N quarter-hours, configured as a scheduling requirement, not a calculated thermal capacity. Minimize the sum of interval prices, assuming the same fixed consumption per interval. Each finite price is rounded with Math.round(price * 1,000,000) to integer micro-SEK/kWh. Scaled prices must be safe integers; sums are compared with bigint. Exact ties at this six-decimal precision choose the earliest UTC start. Negative prices are supported. The returned priceSumSekPerKwh is the sum of rounded prices, not monetary expenditure; conversion to a numeric result is rejected if its scaled sum exceeds the safe integer range.

Summer sets house-heating authority OFF. Winter sets it ON as explicitly required for Phase 1; this supersedes the Phase 0 concept of a separate Winter request. No price-driven house-heating policy or heating curve is inferred. Authority is permission to heat, not a guarantee that equipment runs.

Desired actions are logical requests, not confirmed device state. Emit explicit initial states at window start: hot water ON if the selected block starts immediately, otherwise OFF with ON at the later block start. Emit hot-water OFF at block end, including when it equals window end. Heating authority is set at window start and has no automatic end toggle. Actions are ordered by timestamp, then target using deterministic string comparison. Invalid input, malformed selected-zone prices, or incomplete coverage returns no executable actions and a reason; this does not claim any physical fail-safe state.

## Adapter responsibilities
Implemented SimulatedDeviceAdapter applies actions in caller-supplied order and records a copy of every action and resulting boolean heating/hot-water state. It starts with both states OFF and exposes copied snapshots. It does not wait for timestamps, schedule timers, or contact devices. Future real adapters own target-to-device mapping, command translation, acknowledgements, retries, stale-plan handling, and enforcement of equipment constraints. Telemetry remains planned and would report observations rather than pretending that desired actions succeeded.

Before real control, define equipment interlocks, hot-water hygiene requirements, manual override, loss-of-data behavior, and local autonomy. Core scheduling must never bypass independent equipment safety controls. No real-control behavior is implemented in Phase 1.
