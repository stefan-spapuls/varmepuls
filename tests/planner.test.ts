import test from "node:test";
import assert from "node:assert/strict";
import { planHotWater } from "../src/core/planner.ts";
import { ZONES } from "../src/core/models.ts";
import type { PlanResult, PlannerInput, PriceInterval } from "../src/core/models.ts";
import { SimulatedDeviceAdapter } from "../src/adapters/simulated-device.ts";
import { BLOCK_COMPARISON, input, prices, quarter } from "./fixtures.ts";

function success(result: PlanResult): Extract<PlanResult, { ok: true }> {
  if (!result.ok) assert.fail(result.reason);
  assert.equal(result.ok, true);
  return result;
}
function rejected(value: PlannerInput, code: string): void {
  const result = planHotWater(value);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Unexpected schedule");
  assert.equal(result.code, code);
  assert.ok(result.reason.length > 0);
  assert.deepEqual(result.actions, []);
}

test("cheapest single quarter", () => {
  const result = success(planHotWater(input([9, 2, 7])));
  assert.deepEqual(result.block, { startUtc: quarter(1), endUtc: quarter(2), zone: "SE1", intervalCount: 1, priceSumSekPerKwh: 2 });
});
test("cheapest complete 60-minute block", () => {
  const result = success(planHotWater(input([50, 8, 7, 6, 5, 50], 60)));
  assert.equal(result.block.startUtc, quarter(1));
  assert.equal(result.block.endUtc, quarter(5));
  assert.equal(result.block.priceSumSekPerKwh, 26);
});
test("A=40 beats B=53 despite B's lower individual quarters", () => {
  const result = success(planHotWater(input(BLOCK_COMPARISON, 60)));
  assert.equal(result.block.startUtc, quarter(0));
  assert.equal(result.block.priceSumSekPerKwh, 40);
});
test("non-contiguous cheapest quarters cannot form a block", () => {
  const result = success(planHotWater(input([1, 100, 1, 100, 1, 100, 1, 10, 10, 10, 10], 60)));
  assert.equal(result.block.startUtc, quarter(6));
  assert.equal(result.block.priceSumSekPerKwh, 31);
  assert.equal(result.block.endUtc, quarter(10));
});
test("equal-cost blocks select earliest UTC start", () => {
  const result = success(planHotWater(input([2, 2, 100, 2, 2], 30)));
  assert.equal(result.block.startUtc, quarter(0));
});
test("decimal sums use micro-SEK precision for deterministic ties", () => {
  const result = success(planHotWater(input([0.1, 0.2, 9, 0.15, 0.15], 30)));
  assert.equal(result.block.startUtc, quarter(0));
  assert.equal(result.block.priceSumSekPerKwh, 0.3);
});
for (const [index, zone] of ZONES.entries()) {
  test(`${zone} filters a mixed-zone fixture before planning`, () => {
    const request = input([9, 9, 9, 9], 15, "summer", zone);
    request.prices = ZONES.flatMap((z, i) => prices([0, 1, 2, 3].map(j => j === i ? -10 : 10), z));
    const result = success(planHotWater(request));
    assert.equal(result.block.zone, zone);
    assert.equal(result.block.startUtc, quarter(index));
    assert.equal(result.block.priceSumSekPerKwh, -10);
  });
}
for (const mode of ["summer", "winter"] as const) {
  test(`${mode} sets heating authority and still plans hot water`, () => {
    const result = success(planHotWater(input([9, 1, 8], 15, mode)));
    assert.deepEqual(result.actions, [
      { atUtc: quarter(0), target: "domestic-hot-water", enabled: false },
      { atUtc: quarter(0), target: "house-heating", enabled: mode === "winter" },
      { atUtc: quarter(1), target: "domestic-hot-water", enabled: true },
      { atUtc: quarter(2), target: "domestic-hot-water", enabled: false },
    ]);
  });
}
test("invalid timestamp rejected", () => {
  const value = input([1]); value.prices = [{ ...value.prices[0], startUtc: "invalid" }];
  rejected(value, "INVALID_PRICES");
});
test("30-minute price interval rejected", () => {
  const value = input([1, 2]); value.prices = [{ ...value.prices[0], endUtc: quarter(2) }];
  rejected(value, "INVALID_PRICES");
});
test("unaligned 15-minute price interval rejected", () => {
  const value = input([1]); value.prices = [{ ...value.prices[0], startUtc: "2026-01-15T00:01:00Z", endUtc: "2026-01-15T00:16:00Z" }];
  rejected(value, "INVALID_PRICES");
});
test("nonexistent calendar date rejected rather than normalized", () => {
  const value = input([1]); value.prices = [{ ...value.prices[0], startUtc: "2026-02-30T00:00:00Z", endUtc: "2026-02-30T00:15:00Z" }];
  rejected(value, "INVALID_PRICES");
});
test("non-UTC timestamps rejected", () => {
  const value = input([1]); value.prices = [{ ...value.prices[0], startUtc: "2026-01-15T01:00:00+01:00" }];
  rejected(value, "INVALID_PRICES");
});
for (const badPrice of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
  test(`unsupported price ${badPrice} rejected`, () => rejected(input([badPrice]), "INVALID_PRICES"));
}
test("duplicate selected-zone interval rejected", () => {
  const value = input([1, 2]); value.prices = [...value.prices, value.prices[0]];
  rejected(value, "INVALID_PRICES");
});
test("missing middle quarter returns no executable actions", () => {
  const value = input([1, 2, 3, 4, 5], 60); value.prices = value.prices.filter((_, i) => i !== 2);
  rejected(value, "INSUFFICIENT_COVERAGE");
});
test("missing end coverage cannot invent a schedule", () => {
  const value = input([1, 2, 3, 4], 60); value.prices = value.prices.slice(0, 3);
  rejected(value, "INSUFFICIENT_COVERAGE");
});
test("empty selected-zone coverage rejected", () => {
  const value = input([1, 2], 15, "summer", "SE2"); value.prices = prices([1, 2], "SE1");
  rejected(value, "INSUFFICIENT_COVERAGE");
});
test("runtime longer than window rejected", () => rejected(input([1, 2], 60), "INSUFFICIENT_COVERAGE"));
for (const runtime of [0, -15, 16, 7.5, NaN]) {
  test(`invalid runtime ${runtime} rejected`, () => rejected(input([1, 2], runtime), "INVALID_INPUT"));
}
test("unknown zone rejected", () => rejected({ ...input([1]), zone: "SE5" } as unknown as PlannerInput, "INVALID_INPUT"));
test("unknown mode rejected", () => rejected({ ...input([1]), mode: "automatic" } as unknown as PlannerInput, "INVALID_INPUT"));
test("unknown fixture zone rejected", () => {
  const value = input([1]); value.prices = [{ ...value.prices[0], zone: "SE5" }] as unknown as PriceInterval[];
  rejected(value, "INVALID_PRICES");
});
test("reversed planning window rejected", () => {
  const value = input([1]); value.window = { startUtc: quarter(1), endUtc: quarter(0) };
  rejected(value, "INVALID_INPUT");
});
test("unaligned planning window rejected", () => {
  const value = input([1]); value.window.startUtc = "2026-01-15T00:01:00Z";
  rejected(value, "INVALID_INPUT");
});
test("window excludes cheaper out-of-window quarters", () => {
  const value = input([-100, 2, 1, -100]); value.window = { startUtc: quarter(1), endUtc: quarter(3) };
  const result = success(planHotWater(value));
  assert.equal(result.block.startUtc, quarter(2));
  assert.equal(result.block.endUtc, quarter(3));
});
test("negative prices select lowest total", () => {
  const result = success(planHotWater(input([0, -5, -2, 1], 30)));
  assert.equal(result.block.startUtc, quarter(1));
  assert.equal(result.block.priceSumSekPerKwh, -7);
});
test("block at window start has one initial ON and ends OFF at window end", () => {
  const result = success(planHotWater(input([1, 2, 3, 4], 60)));
  assert.deepEqual(result.actions, [
    { atUtc: quarter(0), target: "domestic-hot-water", enabled: true },
    { atUtc: quarter(0), target: "house-heating", enabled: false },
    { atUtc: quarter(4), target: "domestic-hot-water", enabled: false },
  ]);
});
test("simulated adapter records each action and resulting state", async () => {
  const plan = success(planHotWater(input([9, 1, 8], 15, "winter")));
  const device = new SimulatedDeviceAdapter();
  for (const action of plan.actions) await device.apply(action);
  assert.deepEqual(device.history.map(entry => entry.action), plan.actions);
  assert.deepEqual(device.history.map(entry => entry.state), [
    { houseHeating: false, hotWater: false },
    { houseHeating: true, hotWater: false },
    { houseHeating: true, hotWater: true },
    { houseHeating: true, hotWater: false },
  ]);
  assert.deepEqual(device.state, { houseHeating: true, hotWater: false });
});
test("simulation snapshots cannot mutate recorded state", async () => {
  const device = new SimulatedDeviceAdapter();
  const action = { atUtc: quarter(0), target: "domestic-hot-water" as const, enabled: true };
  await device.apply(action); action.enabled = false;
  const snapshot = device.history; snapshot[0].state.hotWater = false;
  snapshot[0].action.enabled = false;
  const state = device.state; state.hotWater = false;
  assert.equal(device.state.hotWater, true);
  assert.equal(device.history[0].action.enabled, true);
  assert.equal(device.history[0].state.hotWater, true);
});
test("identical calls are identical and input remains unchanged", () => {
  const value = input(BLOCK_COMPARISON, 60); const before = structuredClone(value);
  const expected = planHotWater(value);
  for (let i = 0; i < 20; i++) assert.deepEqual(planHotWater(value), expected);
  assert.deepEqual(value, before);
});
test("unsorted fixture yields same schedule without mutating input", () => {
  const value = input([3, 1, 2]); const expected = planHotWater(value);
  value.prices = [...value.prices].reverse(); const before = structuredClone(value);
  assert.deepEqual(planHotWater(value), expected);
  assert.deepEqual(value, before);
});
