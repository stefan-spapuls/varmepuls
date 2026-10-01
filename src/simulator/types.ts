import type { DesiredAction, PriceInterval } from "../core/models.ts";

export interface HouseModel {
  /** Electrical input while the virtual heating system is enabled. */
  heatingPowerKw: number;
  /** Effective stored heat in kWh per degree C. */
  thermalCapacityKwhPerC: number;
  /** Fraction of indoor/outdoor temperature difference lost per hour. */
  heatLossFractionPerHour: number;
}

export interface HotWaterModel {
  heaterPowerKw: number;
  thermalCapacityKwhPerC: number;
  /** Fraction of tank/room temperature difference lost per hour. */
  standingLossFractionPerHour: number;
  roomTemperatureC: number;
}

export interface ThermalState {
  indoorTemperatureC: number;
  outdoorTemperatureC: number;
  tankTemperatureC: number;
  houseHeatingEnabled: boolean;
  hotWaterEnabled: boolean;
}

export interface HotWaterDraw {
  /** Applied at the beginning of the matching 15-minute simulation step. */
  atUtc: string;
  /** Heat removed from the tank in kWh; this is a synthetic draw simplification. */
  energyKwh: number;
}

export interface LocalSafetyPolicy {
  minimumIndoorTemperatureC: number;
  /** Heating may return to plan authority above minimum + this margin. */
  recoveryHysteresisC: number;
}

export interface SimulationInput {
  scenarioName: string;
  startUtc: string;
  endUtc: string;
  initialState: ThermalState;
  house: HouseModel;
  hotWater: HotWaterModel;
  /** Actions are the logical actions emitted by Core or a comparison policy. */
  actions: readonly DesiredAction[];
  prices: readonly PriceInterval[];
  draws?: readonly HotWaterDraw[];
  localSafety?: LocalSafetyPolicy;
  selectedHotWaterPeriod?: { startUtc: string; endUtc: string };
}

export interface SimulationStep {
  startUtc: string;
  priceSekPerKwh: number;
  houseHeatingEnabled: boolean;
  hotWaterEnabled: boolean;
  houseHeatingEnergyKwh: number;
  hotWaterEnergyKwh: number;
  totalEnergyKwh: number;
  costSek: number;
  indoorTemperatureC: number;
  tankTemperatureC: number;
}

export interface SimulationResult {
  scenarioName: string;
  startUtc: string;
  endUtc: string;
  stepCount: number;
  initialIndoorTemperatureC: number;
  finalIndoorTemperatureC: number;
  minimumIndoorTemperatureC: number;
  maximumIndoorTemperatureC: number;
  initialTankTemperatureC: number;
  finalTankTemperatureC: number;
  minimumTankTemperatureC: number;
  maximumTankTemperatureC: number;
  houseHeatingEnergyKwh: number;
  hotWaterEnergyKwh: number;
  totalEnergyKwh: number;
  totalCostSek: number;
  selectedHotWaterPeriod?: { startUtc: string; endUtc: string };
  localSafetyInterventions: number;
  steps: readonly SimulationStep[];
}
