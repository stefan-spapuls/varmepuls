import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planHotWater } from "../core/planner.ts";
import type { DesiredAction, Mode, PriceInterval } from "../core/models.ts";
import { simulate } from "./model.ts";
import type { SimulationInput, SimulationResult } from "./types.ts";

const START_UTC = "2026-01-15T00:00:00.000Z";
const QUARTER_MS = 15 * 60 * 1000;
const ZONE = "SE4" as const;
const RUNTIME_MINUTES = 60;
const HOUSE = { heatingPowerKw: 4, thermalCapacityKwhPerC: 20, heatLossFractionPerHour: 0.01 };
const HOT_WATER = { heaterPowerKw: 2, thermalCapacityKwhPerC: 0.35, standingLossFractionPerHour: 0.005, roomTemperatureC: 20 };
const SAFETY = { minimumIndoorTemperatureC: 16, recoveryHysteresisC: 0.5 };

export interface DemoRun {
  name: string;
  mode: Mode;
  prices: readonly PriceInterval[];
  optimized: SimulationResult;
  baseline: SimulationResult;
}

function isoQuarter(index: number): string {
  return new Date(Date.parse(START_UTC) + index * QUARTER_MS).toISOString();
}

function syntheticPrices(name: string): PriceInterval[] {
  return Array.from({ length: 96 }, (_, index) => {
    let priceSekPerKwh: number;
    if (name === "EXPENSIVE PERIOD") {
      // One early cheap window and a uniquely cheaper later window, separated by expensive prices.
      if (index >= 20 && index < 24) priceSekPerKwh = 0.34;
      else if (index >= 72 && index < 76) priceSekPerKwh = 0.08;
      else if (index >= 24 && index < 60) priceSekPerKwh = 2.1;
      else priceSekPerKwh = 0.8 + (index % 5) * 0.03;
    } else {
      priceSekPerKwh = 0.35 + ((index * 7 + (name === "WINTER" ? 3 : 0)) % 13) * 0.035;
    }
    return {
      startUtc: isoQuarter(index), endUtc: isoQuarter(index + 1), zone: ZONE, priceSekPerKwh,
    };
  });
}

function baselineActions(planActions: readonly DesiredAction[], fixedStartIndex: number): DesiredAction[] {
  const start = Date.parse(START_UTC);
  const end = start + 96 * QUARTER_MS;
  const fixedStart = start + fixedStartIndex * QUARTER_MS;
  const fixedEnd = fixedStart + (RUNTIME_MINUTES / 15) * QUARTER_MS;
  const actions: DesiredAction[] = planActions.filter((action) => action.target === "house-heating").map((action) => ({ ...action }));
  if (fixedStart === start) actions.push({ atUtc: new Date(start).toISOString(), target: "domestic-hot-water", enabled: true });
  else {
    actions.push({ atUtc: new Date(start).toISOString(), target: "domestic-hot-water", enabled: false });
    actions.push({ atUtc: new Date(fixedStart).toISOString(), target: "domestic-hot-water", enabled: true });
  }
  actions.push({ atUtc: new Date(fixedEnd).toISOString(), target: "domestic-hot-water", enabled: false });
  return actions.filter((action) => Date.parse(action.atUtc) <= end)
    .sort((a, b) => a.atUtc.localeCompare(b.atUtc) || a.target.localeCompare(b.target));
}

function runScenario(name: string, mode: Mode, outdoorTemperatureC: number, initialTankTemperatureC: number, fixedStartIndex: number): DemoRun {
  const prices = syntheticPrices(name);
  const endUtc = new Date(Date.parse(START_UTC) + 96 * QUARTER_MS).toISOString();
  const plan = planHotWater({
    prices, zone: ZONE, mode, runtimeMinutes: RUNTIME_MINUTES,
    window: { startUtc: START_UTC, endUtc },
  });
  if (!plan.ok) throw new Error(`Core planner rejected ${name} demo prices: ${plan.reason}`);
  const drawAtUtc = isoQuarter(28);
  const common: Omit<SimulationInput, "actions"> = {
    scenarioName: name, startUtc: START_UTC, endUtc,
    initialState: {
      indoorTemperatureC: 21, outdoorTemperatureC, tankTemperatureC: initialTankTemperatureC,
      houseHeatingEnabled: false, hotWaterEnabled: false,
    },
    house: HOUSE, hotWater: HOT_WATER,
    prices, draws: [{ atUtc: drawAtUtc, energyKwh: 1.4 }], localSafety: SAFETY,
    selectedHotWaterPeriod: { startUtc: plan.block.startUtc, endUtc: plan.block.endUtc },
  };
  return {
    name, mode, prices,
    optimized: simulate({ ...common, actions: plan.actions }),
    baseline: simulate({ ...common, actions: baselineActions(plan.actions, fixedStartIndex) }),
  };
}

export function runDemoScenarios(): DemoRun[] {
  return [
    runScenario("SUMMER", "summer", 24, 50, 0),
    runScenario("WINTER", "winter", 2, 48, 0),
    runScenario("EXPENSIVE PERIOD", "summer", 12, 50, 0),
  ];
}

function format(value: number): string { return value.toFixed(2); }

function printRun(run: DemoRun): void {
  const plan = run.optimized.selectedHotWaterPeriod;
  console.log(`\n${run.name} — ${run.optimized.startUtc} to ${run.optimized.endUtc}`);
  console.log(`Core-selected hot water: ${plan?.startUtc} → ${plan?.endUtc}`);
  console.log(`15-minute steps: ${run.optimized.stepCount}`);
  console.log("Strategy       House kWh   Water kWh   Total kWh   Cost SEK   Indoor min/max/final °C   Tank min/max/final °C");
  for (const [label, result] of [["Planned", run.optimized], ["Fixed-time", run.baseline]] as const) {
    const indoor = `${format(result.minimumIndoorTemperatureC)}/${format(result.maximumIndoorTemperatureC)}/${format(result.finalIndoorTemperatureC)}`;
    const tank = `${format(result.minimumTankTemperatureC)}/${format(result.maximumTankTemperatureC)}/${format(result.finalTankTemperatureC)}`;
    console.log(`${label.padEnd(14)} ${format(result.houseHeatingEnergyKwh).padStart(9)} ${format(result.hotWaterEnergyKwh).padStart(11)} ${format(result.totalEnergyKwh).padStart(11)} ${format(result.totalCostSek).padStart(10)} ${indoor.padStart(24)} ${tank.padStart(25)}`);
  }
  console.log(`Cost difference (fixed-time minus planned): ${format(run.baseline.totalCostSek - run.optimized.totalCostSek)} SEK`);
  console.log(`Local safety interventions: ${run.optimized.localSafetyInterventions}`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  console.log("VärmePuls hardware-free deterministic demo (synthetic prices and household only)");
  for (const run of runDemoScenarios()) printRun(run);
}
