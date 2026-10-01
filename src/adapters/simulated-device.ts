import type { DesiredAction, DeviceAdapter } from "../core/models.ts";

export interface SimulatedState {
  houseHeating: boolean;
  hotWater: boolean;
}

/** Applies events in supplied order, without timers or real device access. */
export class SimulatedDeviceAdapter implements DeviceAdapter {
  private current: SimulatedState = { houseHeating: false, hotWater: false };
  private recorded: { action: DesiredAction; state: SimulatedState }[] = [];

  get state(): SimulatedState { return { ...this.current }; }
  get history(): readonly { action: DesiredAction; state: SimulatedState }[] {
    return this.recorded.map(entry => ({ action: { ...entry.action }, state: { ...entry.state } }));
  }

  async apply(action: DesiredAction): Promise<void> {
    if (action.target === "house-heating") this.current.houseHeating = action.enabled;
    else this.current.hotWater = action.enabled;
    this.recorded.push({ action: { ...action }, state: { ...this.current } });
  }
}
