import test from "node:test";
import assert from "node:assert/strict";
import { normalizePrices, OfflinePriceProvider, toSekPerKwh } from "../src/adapters/price-provider.ts";
import type { NormalizedPriceBatch, PriceProvider, PriceProviderResult, PriceRequest, SourcePriceInterval, SourcePriceUnit } from "../src/adapters/price-provider.ts";
import { planHotWater } from "../src/core/planner.ts";
import { quarter } from "./fixtures.ts";

const request: PriceRequest = { zone: "SE3", window: { startUtc: quarter(0), endUtc: quarter(4) } };
function records(values: readonly unknown[] = [100, 200, -300, 0]): SourcePriceInterval[] {
  return values.map((value, i) => ({ startUtc: quarter(i), endUtc: quarter(i + 1), zone: "SE3", value }));
}
function batch(result: PriceProviderResult): NormalizedPriceBatch {
  if (!result.ok) assert.fail(result.reason);
  assert.equal(result.ok, true);
  return result.batch;
}
function rejected(result: PriceProviderResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Unexpected normalized batch");
  assert.equal(result.code, code);
  assert.ok(result.reason.length > 0);
  assert.equal("batch" in result, false);
}

for (const [name, source, expected] of [
  ["positive", 1250, 1.25], ["zero", 0, 0], ["negative", -250, -0.25], ["decimal", 1234.56, 1.23456],
] as const) {
  test(`SEK/MWh converts ${name} source price to SEK/kWh`, () => {
    const actual = toSekPerKwh(source, "SEK/MWh");
    // Division uses IEEE-754; tolerate at most one epsilon, not a pricing error.
    assert.ok(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(expected)));
  });
}
test("canonical SEK/kWh is preserved without second conversion", () => {
  assert.equal(toSekPerKwh(-0.1234567, "SEK/kWh"), -0.1234567);
});
for (const value of [NaN, Infinity, -Infinity, "100", null, undefined, Number.MAX_VALUE]) {
  test(`invalid source value ${String(value)} rejected`, () => {
    assert.throws(() => toSekPerKwh(value, "SEK/MWh"));
    rejected(normalizePrices(request, records([value, 0, 0, 0]), "SEK/MWh"), "INVALID_SOURCE");
  });
}
test("unsupported source unit rejected explicitly", () => {
  const unsupported = "EUR/MWh" as SourcePriceUnit;
  assert.throws(() => toSekPerKwh(100, unsupported));
  rejected(normalizePrices(request, records(), unsupported), "UNSUPPORTED_UNIT");
});
test("normalized batch declares canonical unit, basis, zone, and window", () => {
  const result = batch(normalizePrices(request, records(), "SEK/MWh"));
  assert.equal(result.unit, "SEK/kWh");
  assert.equal(result.costBasis, "spot-energy-only");
  assert.equal(result.zone, request.zone);
  assert.deepEqual(result.window, request.window);
  assert.deepEqual(result.intervals.map(p => p.priceSekPerKwh), [0.1, 0.2, -0.3, 0]);
});
test("mock implements provider contract and feeds unchanged Core planner", async () => {
  const provider: PriceProvider = new OfflinePriceProvider(records(), "SEK/MWh");
  const normalized = batch(await provider.getPrices(request));
  const plan = planHotWater({ prices: normalized.intervals, zone: normalized.zone,
    window: normalized.window, mode: "summer", runtimeMinutes: 15 });
  if (!plan.ok) assert.fail(plan.reason);
  assert.equal(plan.ok, true);
  assert.equal(plan.block.startUtc, quarter(2));
  assert.equal(plan.block.priceSumSekPerKwh, -0.3);
});
test("mock snapshots input and repeated requests produce independent batches", async () => {
  const source = records(); const provider = new OfflinePriceProvider(source, "SEK/MWh");
  source[0].value = 99999;
  const first = batch(await provider.getPrices(request));
  first.window.startUtc = "changed";
  const second = batch(await provider.getPrices(request));
  assert.deepEqual(second, batch(normalizePrices(request, records(), "SEK/MWh")));
});
test("source records sorted chronologically without mutation", () => {
  const source = records().reverse(); const before = structuredClone(source);
  const result = batch(normalizePrices(request, source, "SEK/MWh"));
  assert.deepEqual(result.intervals.map(p => p.startUtc), [quarter(0), quarter(1), quarter(2), quarter(3)]);
  assert.deepEqual(source, before);
});
test("wrong zone rejected instead of relabeled", () => {
  const source = records(); source[1].zone = "SE4";
  rejected(normalizePrices(request, source, "SEK/MWh"), "WRONG_ZONE");
});
test("duplicate source interval rejected", () => {
  const source = records(); source.push(source[0]);
  rejected(normalizePrices(request, source, "SEK/MWh"), "DUPLICATE");
});
test("overlapping source intervals rejected", () => {
  const source = records(); source[0].endUtc = quarter(2);
  rejected(normalizePrices(request, source, "SEK/MWh"), "OVERLAP");
});
test("missing middle interval returns no partial batch", () => {
  rejected(normalizePrices(request, records().filter((_, i) => i !== 1), "SEK/MWh"), "MISSING_COVERAGE");
});
test("missing final interval rejected", () => rejected(normalizePrices(request, records().slice(0, -1), "SEK/MWh"), "MISSING_COVERAGE"));
test("empty batch rejected", () => rejected(normalizePrices(request, [], "SEK/MWh"), "MISSING_COVERAGE"));
test("malformed source record rejected", () => rejected(normalizePrices(request, [null], "SEK/MWh"), "INVALID_SOURCE"));
test("non-array source rejected", () => rejected(normalizePrices(request, {}, "SEK/MWh"), "INVALID_SOURCE"));
test("invalid timestamp rejected", () => {
  const source = records(); source[0].startUtc = "2026-02-30T00:00:00Z";
  rejected(normalizePrices(request, source, "SEK/MWh"), "INVALID_INTERVAL");
});
test("offset timestamp must be converted to UTC before normalization", () => {
  const source = records(); source[0].startUtc = "2026-01-15T01:00:00+01:00";
  rejected(normalizePrices(request, source, "SEK/MWh"), "INVALID_INTERVAL");
});
test("hourly prices are not silently expanded", () => {
  rejected(normalizePrices(request, [{ ...records()[0], endUtc: quarter(4) }], "SEK/MWh"), "INVALID_INTERVAL");
});
test("unaligned quarter interval rejected", () => {
  const source = [{ ...records()[0], startUtc: "2026-01-15T00:01:00Z", endUtc: "2026-01-15T00:16:00Z" }];
  rejected(normalizePrices(request, source, "SEK/MWh"), "INVALID_INTERVAL");
});
test("out-of-window source interval rejected", () => {
  const source = records(); source.push({ ...source[0], startUtc: quarter(4), endUtc: quarter(5) });
  rejected(normalizePrices(request, source, "SEK/MWh"), "OUTSIDE_WINDOW");
});
test("invalid request window rejected", () => {
  rejected(normalizePrices({ ...request, window: { startUtc: quarter(4), endUtc: quarter(0) } }, records(), "SEK/MWh"), "INVALID_REQUEST");
});

const marketDays = [
  { name: "normal", date: "2026-01-15", next: "2026-01-16", from: "2026-01-14T23:00:00Z", to: "2026-01-15T23:00:00Z", count: 96 },
  { name: "spring DST", date: "2026-03-29", next: "2026-03-30", from: "2026-03-28T23:00:00Z", to: "2026-03-29T22:00:00Z", count: 92 },
  { name: "autumn DST", date: "2026-10-25", next: "2026-10-26", from: "2026-10-24T22:00:00Z", to: "2026-10-25T23:00:00Z", count: 100 },
] as const;
const stockholm = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
for (const day of marketDays) {
  test(`${day.name} Stockholm day accepts ${day.count} quarters, not a fixed 96`, () => {
    assert.equal(stockholm.format(new Date(day.from)), `${day.date} 00:00`);
    assert.equal(stockholm.format(new Date(day.to)), `${day.next} 00:00`);
    const from = Date.parse(day.from); const to = Date.parse(day.to);
    assert.equal((to - from) / 900_000, day.count);
    const source = Array.from({ length: day.count }, (_, i) => ({
      zone: "SE3", startUtc: new Date(from + i * 900_000).toISOString(),
      endUtc: new Date(from + (i + 1) * 900_000).toISOString(), value: 1000,
    }));
    const result = batch(normalizePrices({ zone: "SE3", window: { startUtc: day.from, endUtc: day.to } }, source, "SEK/MWh"));
    assert.equal(result.intervals.length, day.count);
    const plan = planHotWater({ zone: "SE3", window: result.window, prices: result.intervals, mode: "winter", runtimeMinutes: 60 });
    assert.equal(plan.ok, true);
  });
}
