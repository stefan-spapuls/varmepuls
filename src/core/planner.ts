import { ZONES } from "./models.ts";
import type { DesiredAction, PlanResult, PlannerInput } from "./models.ts";

const QUARTER_MS = 15 * 60 * 1000;
const PRICE_SCALE = 1_000_000;

function utcQuarter(value: unknown): number | undefined {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)) return;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms % QUARTER_MS !== 0) return;
  // Reject dates that JavaScript would silently normalize (e.g. February 30).
  if (new Date(ms).toISOString() !== value.replace(/Z$/, ".000Z").replace(".000.000", ".000")) return;
  return ms;
}

function failure(code: "INVALID_INPUT" | "INVALID_PRICES" | "INSUFFICIENT_COVERAGE", reason: string): PlanResult {
  return { ok: false, code, reason, actions: [] };
}

/** Pure offline planner. No current clock, randomness, I/O, or device commands. */
export function planHotWater(input: PlannerInput): PlanResult {
  if (!input || !ZONES.includes(input.zone) ||
      (input.mode !== "summer" && input.mode !== "winter") ||
      !Number.isSafeInteger(input.runtimeMinutes) || input.runtimeMinutes <= 0 ||
      input.runtimeMinutes % 15 !== 0 || !input.window || !Array.isArray(input.prices)) {
    return failure("INVALID_INPUT", "Select SE1-SE4, summer/winter, and a positive whole-quarter runtime.");
  }
  const from = utcQuarter(input.window.startUtc);
  const to = utcQuarter(input.window.endUtc);
  if (from === undefined || to === undefined || from >= to) {
    return failure("INVALID_INPUT", "Window must have increasing UTC quarter-hour boundaries.");
  }
  const required = input.runtimeMinutes / 15;
  if (input.runtimeMinutes * 60_000 > to - from) {
    return failure("INSUFFICIENT_COVERAGE", "Runtime exceeds the allowed planning window.");
  }

  const selected: { start: number; end: number; price: bigint }[] = [];
  for (const interval of input.prices) {
    if (!interval || !ZONES.includes(interval.zone)) {
      return failure("INVALID_PRICES", "Each price interval must identify a supported zone.");
    }
    if (interval.zone !== input.zone) continue;
    const start = utcQuarter(interval.startUtc);
    const end = utcQuarter(interval.endUtc);
    const scaled = Math.round(interval.priceSekPerKwh * PRICE_SCALE);
    if (start === undefined || end === undefined || end - start !== QUARTER_MS ||
        typeof interval.priceSekPerKwh !== "number" || !Number.isFinite(interval.priceSekPerKwh) ||
        !Number.isSafeInteger(scaled)) {
      return failure("INVALID_PRICES", "Selected-zone prices must be finite, bounded, aligned 15-minute UTC intervals.");
    }
    selected.push({ start, end, price: BigInt(scaled) });
  }
  selected.sort((a, b) => a.start - b.start);
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].start < selected[i - 1].end) {
      return failure("INVALID_PRICES", "Selected-zone intervals overlap or are duplicated.");
    }
  }
  const eligible = selected.filter(p => p.start >= from && p.end <= to);
  if (eligible.length !== (to - from) / QUARTER_MS ||
      eligible.some((p, i) => p.start !== from + i * QUARTER_MS)) {
    return failure("INSUFFICIENT_COVERAGE", "Selected zone must cover the entire window without missing quarters.");
  }

  // Integer micro-SEK/kWh sums avoid floating-point tie instability.
  let sum = 0n;
  for (let i = 0; i < required; i++) sum += eligible[i].price;
  let bestSum = sum;
  let bestIndex = 0;
  for (let end = required; end < eligible.length; end++) {
    sum += eligible[end].price - eligible[end - required].price;
    // Strict improvement preserves the earliest equal-cost block.
    if (sum < bestSum) {
      bestSum = sum;
      bestIndex = end - required + 1;
    }
  }
  if (bestSum > BigInt(Number.MAX_SAFE_INTEGER) || bestSum < BigInt(Number.MIN_SAFE_INTEGER)) {
    return failure("INVALID_PRICES", "Block price sum exceeds the supported exact numeric range.");
  }
  const start = eligible[bestIndex].start;
  const end = eligible[bestIndex + required - 1].end;
  const iso = (ms: number) => new Date(ms).toISOString();
  const actions: DesiredAction[] = [
    { atUtc: iso(from), target: "house-heating", enabled: input.mode === "winter" },
    { atUtc: iso(from), target: "domestic-hot-water", enabled: start === from },
  ];
  if (start !== from) actions.push({ atUtc: iso(start), target: "domestic-hot-water", enabled: true });
  actions.push({ atUtc: iso(end), target: "domestic-hot-water", enabled: false });
  actions.sort((a, b) => a.atUtc < b.atUtc ? -1 : a.atUtc > b.atUtc ? 1 :
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
  return {
    ok: true,
    block: { startUtc: iso(start), endUtc: iso(end), zone: input.zone,
      intervalCount: required, priceSumSekPerKwh: Number(bestSum) / PRICE_SCALE },
    actions,
  };
}
