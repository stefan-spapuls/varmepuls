import test from "node:test";
import assert from "node:assert/strict";
import { planHotWater } from "../src/core/planner.ts";
import type { DesiredAction, PriceInterval } from "../src/core/models.ts";
import { simulate } from "../src/simulator/model.ts";
import { runDemoScenarios } from "../src/simulator/demo.ts";
import type { SimulationInput } from "../src/simulator/types.ts";

const START = Date.parse("2026-01-15T00:00:00.000Z");
const STEP = 15 * 60 * 1000;
const at = (index: number) => new Date(START + index * STEP).toISOString();

function priceFixture(values: readonly number[]): PriceInterval[] {
  return values.map((priceSekPerKwh, index) => ({ startUtc: at(index), endUtc: at(index + 1), zone: "SE4", priceSekPerKwh }));
}

function base(values: readonly number[] = [1, 1, 1, 1]): SimulationInput {
  return {
    scenarioName: "test", startUtc: at(0), endUtc: at(values.length),
    initialState: { indoorTemperatureC: 21, outdoorTemperatureC: 5, tankTemperatureC: 50, houseHeatingEnabled: false, hotWaterEnabled: false },
    house: { heatingPowerKw: 4, thermalCapacityKwhPerC: 20, heatLossFractionPerHour: 0.01 },
    hotWater: { heaterPowerKw: 2, thermalCapacityKwhPerC: 0.35, standingLossFractionPerHour: 0.005, roomTemperatureC: 20 },
    actions: [], prices: priceFixture(values),
  };
}

function plan(values: readonly number[], runtimeMinutes: number, mode: "summer" | "winter" = "summer") {
  const result = planHotWater({ prices: priceFixture(values), zone: "SE4", mode, runtimeMinutes, window: { startUtc: at(0), endUtc: at(values.length) } });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

test("identical inputs produce identical simulation results without mutation", () => {
  const input = base([0.2, 0, -0.1, 0.5]);
  const before = structuredClone(input);
  const expected = simulate(input);
  assert.deepEqual(simulate(input), expected);
  assert.deepEqual(input, before);
});

test("15-minute energy uses kW multiplied by one quarter hour", () => {
  const input = base([0.5]);
  input.actions = [{ atUtc: at(0), target: "house-heating", enabled: true }, { atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const result = simulate(input);
  assert.equal(result.houseHeatingEnergyKwh, 1);
  assert.equal(result.hotWaterEnergyKwh, 0.5);
  assert.equal(result.totalEnergyKwh, 1.5);
});

test("house loses heat toward outdoors while heating is off", () => {
  const input = base([1, 1, 1, 1]);
  input.initialState.outdoorTemperatureC = 0;
  assert.ok(simulate(input).finalIndoorTemperatureC < 21);
});

test("house heating raises indoor temperature relative to the same unheated run", () => {
  const off = base([1]);
  const on = base([1]);
  on.actions = [{ atUtc: at(0), target: "house-heating", enabled: true }];
  assert.ok(simulate(on).finalIndoorTemperatureC > simulate(off).finalIndoorTemperatureC);
});

test("hot-water tank loses heat through standing loss", () => {
  const input = base([1, 1, 1, 1]);
  assert.ok(simulate(input).finalTankTemperatureC < 50);
});

test("hot-water heating raises tank temperature", () => {
  const input = base([1]);
  input.actions = [{ atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  assert.ok(simulate(input).finalTankTemperatureC > 50);
});

test("configured deterministic draw event reduces tank temperature", () => {
  const noDraw = simulate(base([1]));
  const withDraw = base([1]);
  withDraw.draws = [{ atUtc: at(0), energyKwh: 1.4 }];
  assert.ok(simulate(withDraw).finalTankTemperatureC < noDraw.finalTankTemperatureC);
});

test("Summer Core logical action leaves house heating off and uses zero house energy", () => {
  const corePlan = plan([1, 1, 1, 1], 30, "summer");
  const input = base([1, 1, 1, 1]);
  input.actions = corePlan.actions;
  const result = simulate(input);
  assert.equal(result.houseHeatingEnergyKwh, 0);
  assert.ok(result.steps.every((step) => !step.houseHeatingEnabled));
});

test("Winter Core logical action enables house heating", () => {
  const corePlan = plan([1, 1, 1, 1], 30, "winter");
  const input = base([1, 1, 1, 1]);
  input.actions = corePlan.actions;
  assert.ok(simulate(input).houseHeatingEnergyKwh > 0);
});

test("logical actions drive the virtual house and hot-water state", () => {
  const input = base([1, 1, 1, 1]);
  input.actions = [
    { atUtc: at(0), target: "house-heating", enabled: true },
    { atUtc: at(1), target: "house-heating", enabled: false },
    { atUtc: at(1), target: "domestic-hot-water", enabled: true },
    { atUtc: at(3), target: "domestic-hot-water", enabled: false },
  ];
  const result = simulate(input);
  assert.deepEqual(result.steps.map((step) => step.houseHeatingEnabled), [true, false, false, false]);
  assert.deepEqual(result.steps.map((step) => step.hotWaterEnabled), [false, true, true, false]);
});

test("Core planner-selected hot-water block is honored exactly", () => {
  const values = [1, 1, 1, 0.8, 0.1, 0.1, 0.8, 1];
  const corePlan = plan(values, 30);
  const input = base(values);
  input.actions = corePlan.actions;
  input.selectedHotWaterPeriod = { startUtc: corePlan.block.startUtc, endUtc: corePlan.block.endUtc };
  const result = simulate(input);
  assert.equal(result.selectedHotWaterPeriod?.startUtc, at(4));
  assert.deepEqual(result.steps.map((step) => step.hotWaterEnabled), [false, false, false, false, true, true, false, false]);
});

test("expensive-period demo uses the existing planner to select the later cheap block", () => {
  const scenario = runDemoScenarios().find((run) => run.name === "EXPENSIVE PERIOD");
  assert.ok(scenario);
  assert.equal(scenario.optimized.selectedHotWaterPeriod?.startUtc, at(72));
  assert.equal(scenario.optimized.selectedHotWaterPeriod?.endUtc, at(76));
});

test("kWh totals are accumulated by system", () => {
  const input = base([1, 1]);
  input.actions = [{ atUtc: at(0), target: "house-heating", enabled: true }, { atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const result = simulate(input);
  assert.equal(result.houseHeatingEnergyKwh, 2);
  assert.equal(result.hotWaterEnergyKwh, 1);
  assert.equal(result.totalEnergyKwh, 3);
});

test("SEK cost equals step kWh multiplied by SEK per kWh", () => {
  const input = base([2]);
  input.actions = [{ atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const result = simulate(input);
  assert.equal(result.totalEnergyKwh, 0.5);
  assert.equal(result.totalCostSek, 1);
});

test("negative price creates negative energy cost without changing energy units", () => {
  const input = base([-1]);
  input.actions = [{ atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const result = simulate(input);
  assert.equal(result.hotWaterEnergyKwh, 0.5);
  assert.equal(result.totalCostSek, -0.5);
});

test("zero price yields zero cost while energy remains positive", () => {
  const input = base([0]);
  input.actions = [{ atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const result = simulate(input);
  assert.equal(result.hotWaterEnergyKwh, 0.5);
  assert.equal(result.totalCostSek, 0);
});

test("fixed-time baseline uses the same physical parameters as planned control", () => {
  const [summer] = runDemoScenarios();
  assert.equal(summer.optimized.steps.length, summer.baseline.steps.length);
  assert.deepEqual(summer.optimized.steps.map((step) => step.priceSekPerKwh), summer.baseline.steps.map((step) => step.priceSekPerKwh));
  assert.equal(summer.optimized.initialIndoorTemperatureC, summer.baseline.initialIndoorTemperatureC);
  assert.equal(summer.optimized.initialTankTemperatureC, summer.baseline.initialTankTemperatureC);
});

test("planned and fixed-time demo comparison reports monetary difference", () => {
  const expensive = runDemoScenarios().find((run) => run.name === "EXPENSIVE PERIOD");
  assert.ok(expensive);
  assert.notEqual(expensive.baseline.totalCostSek, expensive.optimized.totalCostSek);
});

test("planning is not guaranteed to save money when the fixed baseline matches a tied cheapest period", () => {
  const values = [0.5, 0.5, 0.5, 0.5];
  const corePlan = plan(values, 30);
  const input = base(values);
  input.actions = corePlan.actions;
  const planned = simulate(input);
  const fixed = base(values);
  fixed.actions = [
    { atUtc: at(0), target: "house-heating", enabled: false },
    { atUtc: at(0), target: "domestic-hot-water", enabled: true },
    { atUtc: at(2), target: "domestic-hot-water", enabled: false },
  ];
  assert.equal(planned.totalCostSek, simulate(fixed).totalCostSek);
});

test("local safety policy forces heat below threshold and records an activation", () => {
  const input = base([1, 1]);
  input.initialState.indoorTemperatureC = 15;
  input.actions = [{ atUtc: at(0), target: "house-heating", enabled: false }];
  input.localSafety = { minimumIndoorTemperatureC: 16, recoveryHysteresisC: 0.5 };
  const result = simulate(input);
  assert.ok(result.steps[0].houseHeatingEnabled);
  assert.ok(result.houseHeatingEnergyKwh > 0);
  assert.equal(result.localSafetyInterventions, 1);
});

test("local safety intervention is deterministic", () => {
  const input = base([1, 1, 1]);
  input.initialState.indoorTemperatureC = 15;
  input.localSafety = { minimumIndoorTemperatureC: 16, recoveryHysteresisC: 0.5 };
  assert.deepEqual(simulate(input), simulate(input));
});

test("simulator uses supplied synthetic prices only and performs no network access", () => {
  const input = base([0.4]);
  input.actions = [{ atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  assert.equal(simulate(input).steps[0].priceSekPerKwh, 0.4);
});

test("simulation has no dependency on the current wall clock", () => {
  const input = base([1, 0.8, 0.2, 0.5]);
  input.actions = [{ atUtc: at(1), target: "domestic-hot-water", enabled: true }];
  const first = simulate(input);
  const originalNow = Date.now;
  try {
    Date.now = () => Number.NaN;
    assert.deepEqual(simulate(input), first);
  } finally {
    Date.now = originalNow;
  }
});

test("caller action and price objects remain unchanged", () => {
  const input = base([1, 0.5, 1]);
  input.actions = [{ atUtc: at(2), target: "domestic-hot-water", enabled: false }, { atUtc: at(0), target: "domestic-hot-water", enabled: true }];
  const before = structuredClone(input);
  simulate(input);
  assert.deepEqual(input, before);
});

test("malformed scenario and action inputs are rejected", () => {
  const empty = base([1]); empty.scenarioName = " ";
  assert.throws(() => simulate(empty), /scenarioName/);
  const malformed = base([1]); malformed.actions = [{ atUtc: at(0), target: "other", enabled: true } as unknown as DesiredAction];
  assert.throws(() => simulate(malformed), /Action is malformed/);
});

test("missing price coverage is rejected instead of inventing a value", () => {
  const input = base([1, 1, 1, 1]);
  input.prices = input.prices.slice(0, 3);
  assert.throws(() => simulate(input), /coverage/);
});

test("duplicate price coverage is rejected", () => {
  const input = base([1, 1]);
  input.prices = [...input.prices, input.prices[0]];
  assert.throws(() => simulate(input), /coverage/);
});

test("hourly interval is rejected instead of being split into synthetic quarters", () => {
  const input = base([1, 1, 1, 1]);
  input.prices = [{ startUtc: at(0), endUtc: at(4), zone: "SE4", priceSekPerKwh: 1 }];
  assert.throws(() => simulate(input), /15-minute/);
});
