import type { DesiredAction, PriceInterval } from "../core/models.ts";
import type { SimulationInput, SimulationResult, SimulationStep, ThermalState } from "./types.ts";

const STEP_MS = 15 * 60 * 1000;
const HOURS_PER_STEP = 0.25;

function quarterUtc(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)) {
    throw new Error(`${label} must be a UTC quarter-hour timestamp.`);
  }
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
  if (!Number.isFinite(milliseconds) || milliseconds % STEP_MS !== 0 || (value !== canonical && value !== canonical.replace(".000Z", "Z"))) {
    throw new Error(`${label} must be a valid UTC quarter-hour timestamp.`);
  }
  return milliseconds;
}

function finite(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`${label} must be a finite number${minimum === undefined ? "" : ` >= ${minimum}`}.`);
  }
  return value;
}

function validateState(state: ThermalState): void {
  finite(state.indoorTemperatureC, "indoorTemperatureC");
  finite(state.outdoorTemperatureC, "outdoorTemperatureC");
  finite(state.tankTemperatureC, "tankTemperatureC");
  if (typeof state.houseHeatingEnabled !== "boolean" || typeof state.hotWaterEnabled !== "boolean") {
    throw new Error("Initial enabled states must be booleans.");
  }
}

function validateActions(actions: readonly DesiredAction[], start: number, end: number): DesiredAction[] {
  if (!Array.isArray(actions)) throw new Error("actions must be an array.");
  return actions.map((action) => {
    if (!action || (action.target !== "house-heating" && action.target !== "domestic-hot-water") || typeof action.enabled !== "boolean") {
      throw new Error("Action is malformed.");
    }
    const at = quarterUtc(action.atUtc, "action.atUtc");
    if (at < start || at > end) throw new Error("Action is outside the simulation window.");
    return { ...action };
  }).sort((a, b) => a.atUtc.localeCompare(b.atUtc) || a.target.localeCompare(b.target));
}

function priceByStep(prices: readonly PriceInterval[], start: number, end: number): number[] {
  if (!Array.isArray(prices)) throw new Error("prices must be an array.");
  const selected = prices.map((price) => {
    if (!price || typeof price.zone !== "string") throw new Error("Price interval is malformed.");
    const intervalStart = quarterUtc(price.startUtc, "price.startUtc");
    const intervalEnd = quarterUtc(price.endUtc, "price.endUtc");
    const value = finite(price.priceSekPerKwh, "priceSekPerKwh");
    if (intervalEnd - intervalStart !== STEP_MS) throw new Error("Prices must be genuine 15-minute intervals.");
    return { start: intervalStart, end: intervalEnd, value };
  }).filter((price) => price.start >= start && price.end <= end).sort((a, b) => a.start - b.start);
  const expectedCount = (end - start) / STEP_MS;
  if (selected.length !== expectedCount || selected.some((item, index) => item.start !== start + index * STEP_MS || item.end !== item.start + STEP_MS)) {
    throw new Error("Price coverage must contain every simulation quarter exactly once; prices are never invented.");
  }
  return selected.map((item) => item.value);
}

function applyActions(state: ThermalState, actions: readonly DesiredAction[], time: number, cursor: { value: number }): void {
  while (cursor.value < actions.length && Date.parse(actions[cursor.value].atUtc) <= time) {
    const action = actions[cursor.value++];
    if (action.target === "house-heating") state.houseHeatingEnabled = action.enabled;
    else state.hotWaterEnabled = action.enabled;
  }
}

/** Runs a pure, deterministic 15-minute virtual household simulation. */
export function simulate(input: SimulationInput): SimulationResult {
  if (!input || typeof input.scenarioName !== "string" || input.scenarioName.trim() === "") throw new Error("scenarioName is required.");
  const start = quarterUtc(input.startUtc, "startUtc");
  const end = quarterUtc(input.endUtc, "endUtc");
  if (end <= start) throw new Error("Simulation end must be after start.");
  validateState(input.initialState);
  const house = {
    heatingPowerKw: finite(input.house?.heatingPowerKw, "house.heatingPowerKw", 0),
    thermalCapacityKwhPerC: finite(input.house?.thermalCapacityKwhPerC, "house.thermalCapacityKwhPerC"),
    heatLossFractionPerHour: finite(input.house?.heatLossFractionPerHour, "house.heatLossFractionPerHour", 0),
  };
  const hotWater = {
    heaterPowerKw: finite(input.hotWater?.heaterPowerKw, "hotWater.heaterPowerKw", 0),
    thermalCapacityKwhPerC: finite(input.hotWater?.thermalCapacityKwhPerC, "hotWater.thermalCapacityKwhPerC"),
    standingLossFractionPerHour: finite(input.hotWater?.standingLossFractionPerHour, "hotWater.standingLossFractionPerHour", 0),
    roomTemperatureC: finite(input.hotWater?.roomTemperatureC, "hotWater.roomTemperatureC"),
  };
  if (house.thermalCapacityKwhPerC <= 0 || hotWater.thermalCapacityKwhPerC <= 0) throw new Error("Thermal capacities must be greater than zero.");
  const count = (end - start) / STEP_MS;
  const prices = priceByStep(input.prices, start, end);
  const actions = validateActions(input.actions, start, end);
  const draws = (input.draws ?? []).map((draw) => {
    const at = quarterUtc(draw.atUtc, "draw.atUtc");
    const energyKwh = finite(draw.energyKwh, "draw.energyKwh", 0);
    if (at < start || at >= end) throw new Error("Hot-water draws must fall inside the simulation window.");
    return { at, energyKwh };
  }).sort((a, b) => a.at - b.at);
  const policy = input.localSafety;
  if (policy) {
    finite(policy.minimumIndoorTemperatureC, "localSafety.minimumIndoorTemperatureC");
    finite(policy.recoveryHysteresisC, "localSafety.recoveryHysteresisC", 0);
  }

  const state = { ...input.initialState };
  const initialIndoor = state.indoorTemperatureC;
  const initialTank = state.tankTemperatureC;
  let minIndoor = initialIndoor;
  let maxIndoor = initialIndoor;
  let minTank = initialTank;
  let maxTank = initialTank;
  let houseEnergy = 0;
  let waterEnergy = 0;
  let cost = 0;
  let interventions = 0;
  let safetyOverride = false;
  const cursor = { value: 0 };
  const drawSteps = new Map<number, number>();
  for (const draw of draws) drawSteps.set(draw.at, (drawSteps.get(draw.at) ?? 0) + draw.energyKwh);
  const steps: SimulationStep[] = [];

  for (let index = 0; index < count; index++) {
    const at = start + index * STEP_MS;
    applyActions(state, actions, at, cursor);
    state.tankTemperatureC -= (drawSteps.get(at) ?? 0) / hotWater.thermalCapacityKwhPerC;

    if (policy) {
      if (safetyOverride && state.indoorTemperatureC >= policy.minimumIndoorTemperatureC + policy.recoveryHysteresisC) safetyOverride = false;
      if (!safetyOverride && state.indoorTemperatureC < policy.minimumIndoorTemperatureC) {
        safetyOverride = true;
        interventions++;
      }
    }
    const houseOn = state.houseHeatingEnabled || safetyOverride;
    const waterOn = state.hotWaterEnabled;
    const houseKwh = houseOn ? house.heatingPowerKw * HOURS_PER_STEP : 0;
    const waterKwh = waterOn ? hotWater.heaterPowerKw * HOURS_PER_STEP : 0;
    const totalKwh = houseKwh + waterKwh;
    const stepCost = totalKwh * prices[index];

    // Heat loss is proportional to the indoor/outdoor difference; electrical input is converted to stored heat.
    state.indoorTemperatureC += (state.outdoorTemperatureC - state.indoorTemperatureC) * house.heatLossFractionPerHour * HOURS_PER_STEP;
    if (houseOn) state.indoorTemperatureC += houseKwh / house.thermalCapacityKwhPerC;
    state.tankTemperatureC -= (state.tankTemperatureC - hotWater.roomTemperatureC) * hotWater.standingLossFractionPerHour * HOURS_PER_STEP;
    if (waterOn) state.tankTemperatureC += waterKwh / hotWater.thermalCapacityKwhPerC;

    houseEnergy += houseKwh;
    waterEnergy += waterKwh;
    cost += stepCost;
    minIndoor = Math.min(minIndoor, state.indoorTemperatureC);
    maxIndoor = Math.max(maxIndoor, state.indoorTemperatureC);
    minTank = Math.min(minTank, state.tankTemperatureC);
    maxTank = Math.max(maxTank, state.tankTemperatureC);
    steps.push({
      startUtc: new Date(at).toISOString(), priceSekPerKwh: prices[index],
      houseHeatingEnabled: houseOn, hotWaterEnabled: waterOn,
      houseHeatingEnergyKwh: houseKwh, hotWaterEnergyKwh: waterKwh,
      totalEnergyKwh: totalKwh, costSek: stepCost,
      indoorTemperatureC: state.indoorTemperatureC, tankTemperatureC: state.tankTemperatureC,
    });
  }

  const result: SimulationResult = {
    scenarioName: input.scenarioName, startUtc: input.startUtc, endUtc: input.endUtc,
    stepCount: count, initialIndoorTemperatureC: initialIndoor, finalIndoorTemperatureC: state.indoorTemperatureC,
    minimumIndoorTemperatureC: minIndoor, maximumIndoorTemperatureC: maxIndoor,
    initialTankTemperatureC: initialTank, finalTankTemperatureC: state.tankTemperatureC,
    minimumTankTemperatureC: minTank, maximumTankTemperatureC: maxTank,
    houseHeatingEnergyKwh: houseEnergy, hotWaterEnergyKwh: waterEnergy,
    totalEnergyKwh: houseEnergy + waterEnergy, totalCostSek: cost,
    localSafetyInterventions: interventions, steps,
  };
  if (input.selectedHotWaterPeriod) result.selectedHotWaterPeriod = { ...input.selectedHotWaterPeriod };
  return result;
}
