import type { PlanningWindow, PriceInterval, Zone } from "../core/models.ts";
import { ZONES } from "../core/models.ts";

export interface PriceRequest {
  zone: Zone;
  /** Explicit half-open UTC window; caller resolves local market dates first. */
  window: PlanningWindow;
}

export interface NormalizedPriceBatch {
  zone: Zone;
  window: PlanningWindow;
  unit: "SEK/kWh";
  costBasis: "spot-energy-only";
  intervals: readonly PriceInterval[];
}

export type PriceProviderResult = {
  ok: true;
  batch: NormalizedPriceBatch;
} | {
  ok: false;
  code: "INVALID_REQUEST" | "UNSUPPORTED_UNIT" | "INVALID_SOURCE" |
    "INVALID_INTERVAL" | "WRONG_ZONE" | "DUPLICATE" | "OVERLAP" |
    "OUTSIDE_WINDOW" | "MISSING_COVERAGE";
  reason: string;
};

export interface PriceProvider {
  getPrices(request: PriceRequest): Promise<PriceProviderResult>;
}

/** Source-unit mapping is an adapter concern; these are not Core units. */
export type SourcePriceUnit = "SEK/kWh" | "SEK/MWh";

export function toSekPerKwh(value: unknown, unit: SourcePriceUnit): number {
  if (unit !== "SEK/kWh" && unit !== "SEK/MWh") throw new Error("Unsupported source unit.");
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Source price must be a finite number.");
  const canonical = unit === "SEK/MWh" ? value / 1000 : value;
  if (!Number.isSafeInteger(Math.round(canonical * 1_000_000))) {
    throw new Error("Source price exceeds the Core numeric range.");
  }
  return canonical;
}

/** Generic source records after an eventual adapter maps its own JSON fields. */
export interface SourcePriceInterval {
  startUtc: unknown;
  endUtc: unknown;
  zone: unknown;
  value: unknown;
}

const QUARTER_MS = 900_000;
type FailureCode = Extract<PriceProviderResult, { ok: false }>['code'];
function failure(code: FailureCode, reason: string): PriceProviderResult {
  return { ok: false, code, reason };
}

function utcInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)) return;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return;
  const canonical = value.endsWith(".000Z") ? value : value.slice(0, -1) + ".000Z";
  if (new Date(ms).toISOString() !== canonical) return;
  return ms;
}

/** All-or-nothing normalization of a complete request, with no invented quarters. */
export function normalizePrices(request: PriceRequest, source: unknown, unit: SourcePriceUnit): PriceProviderResult {
  if (!request || !ZONES.includes(request.zone) || !request.window) {
    return failure("INVALID_REQUEST", "Select a supported zone and explicit UTC window.");
  }
  const from = utcInstant(request.window.startUtc);
  const to = utcInstant(request.window.endUtc);
  if (from === undefined || to === undefined || from >= to || from % QUARTER_MS !== 0 || to % QUARTER_MS !== 0) {
    return failure("INVALID_REQUEST", "Window must have increasing UTC quarter-hour boundaries.");
  }
  if (unit !== "SEK/kWh" && unit !== "SEK/MWh") return failure("UNSUPPORTED_UNIT", "Explicit supported source unit required.");
  if (!Array.isArray(source)) return failure("INVALID_SOURCE", "Source intervals must be an array.");
  const rows: { start: number; end: number; price: number }[] = [];
  for (const record of source as unknown[]) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return failure("INVALID_SOURCE", "Each source interval must be a record.");
    }
    const row = record as Record<string, unknown>;
    if (row["zone"] !== request.zone) return failure("WRONG_ZONE", "Every provider interval must match the requested zone.");
    const start = utcInstant(row["startUtc"]);
    const end = utcInstant(row["endUtc"]);
    if (start === undefined || end === undefined || start >= end) return failure("INVALID_INTERVAL", "Invalid UTC interval timestamps.");
    if (start < from || end > to) return failure("OUTSIDE_WINDOW", "Provider interval falls outside the requested window.");
    let price: number;
    try { price = toSekPerKwh(row["value"], unit); }
    catch { return failure("INVALID_SOURCE", "Invalid or out-of-range source price."); }
    rows.push({ start, end, price });
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  let previous: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (previous && row.start === previous.start && row.end === previous.end) return failure("DUPLICATE", "Duplicate provider interval.");
    if (previous && row.start < previous.end) return failure("OVERLAP", "Overlapping provider intervals.");
    previous = row;
  }
  if (rows.some(row => row.end - row.start !== QUARTER_MS || row.start % QUARTER_MS !== 0)) {
    return failure("INVALID_INTERVAL", "Source must contain aligned, exact 15-minute intervals.");
  }
  if (rows.length !== (to - from) / QUARTER_MS || rows.some((row, index) => row.start !== from + index * QUARTER_MS)) {
    return failure("MISSING_COVERAGE", "Missing requested quarters; no partial batch is returned.");
  }
  return { ok: true, batch: {
    zone: request.zone,
    window: { startUtc: new Date(from).toISOString(), endUtc: new Date(to).toISOString() },
    unit: "SEK/kWh", costBasis: "spot-energy-only",
    intervals: rows.map(row => ({ zone: request.zone, startUtc: new Date(row.start).toISOString(),
      endUtc: new Date(row.end).toISOString(), priceSekPerKwh: row.price })),
  } };
}

/** Offline contract implementation; no transport, credentials, retries, or cache. */
export class OfflinePriceProvider implements PriceProvider {
  private readonly source: unknown;
  private readonly unit: SourcePriceUnit;
  constructor(source: unknown, unit: SourcePriceUnit) {
    this.source = structuredClone(source);
    this.unit = unit;
  }
  async getPrices(request: PriceRequest): Promise<PriceProviderResult> {
    return normalizePrices(request, this.source, this.unit);
  }
}
