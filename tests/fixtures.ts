import type { Mode, PlannerInput, PriceInterval, Zone } from "../src/core/models.ts";

export function quarter(index: number): string {
  return new Date(Date.parse("2026-01-15T00:00:00Z") + index * 900_000).toISOString();
}

export function prices(values: readonly number[], zone: Zone = "SE1"): PriceInterval[] {
  return values.map((priceSekPerKwh, i) => ({ startUtc: quarter(i), endUtc: quarter(i + 1), zone, priceSekPerKwh }));
}

export function input(values: readonly number[], runtimeMinutes = 15, mode: Mode = "summer", zone: Zone = "SE1"): PlannerInput {
  return { prices: prices(values, zone), runtimeMinutes, mode, zone,
    window: { startUtc: quarter(0), endUtc: quarter(values.length) } };
}

// Barrier prevents cheap cross-boundary blocks from obscuring A versus B.
export const BLOCK_COMPARISON = [10, 10, 10, 10, 100, 1, 1, 50, 1] as const;
