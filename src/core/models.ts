export const ZONES = ["SE1", "SE2", "SE3", "SE4"] as const;
export type Zone = (typeof ZONES)[number];
export type Mode = "summer" | "winter";

export interface PriceInterval {
  startUtc: string;
  endUtc: string;
  zone: Zone;
  /** Spot energy price in SEK/kWh; excludes VAT, taxes, fees, and markup. */
  priceSekPerKwh: number;
}

export interface PlanningWindow {
  startUtc: string;
  endUtc: string;
}

export interface PlannerInput {
  prices: readonly PriceInterval[];
  zone: Zone;
  mode: Mode;
  runtimeMinutes: number;
  window: PlanningWindow;
}

export interface DesiredAction {
  atUtc: string;
  target: "domestic-hot-water" | "house-heating";
  enabled: boolean;
}

export interface DeviceAdapter {
  apply(action: DesiredAction): Promise<void>;
}

export type PlanResult = {
  ok: true;
  block: {
    startUtc: string;
    endUtc: string;
    zone: Zone;
    intervalCount: number;
    // Sum of normalized SEK/kWh prices; not a household bill or monetary cost.
    priceSumSekPerKwh: number;
  };
  actions: readonly DesiredAction[];
} | {
  ok: false;
  code: "INVALID_INPUT" | "INVALID_PRICES" | "INSUFFICIENT_COVERAGE";
  reason: string;
  actions: readonly [];
};
