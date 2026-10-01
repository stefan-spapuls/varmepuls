# Hardware-free household simulator

## Purpose and boundaries

The simulator gives contributors a deterministic, hardware-free way to see how VärmePuls logical plans affect a generic house, a hot-water tank, energy use, and spot-energy cost. It is a demonstration model, not a calibrated model of a particular home.

The data flow is:

```text
synthetic or normalized prices → existing Core planner → logical actions
  → virtual controller and thermal model → temperatures, kWh, and SEK cost
```

The simulator does not contain a second planner. Flexible hot-water actions come from `planHotWater` in the existing Core. A comparison strategy replaces only the hot-water timing with a fixed schedule; both strategies use the same thermal parameters, initial state, draw events, and price intervals. No provider is called by the simulator.

## Deterministic time and inputs

Simulation advances in fixed 15-minute UTC steps. Start/end times, logical actions, hot-water draw events, and normalized prices are explicit inputs. There is no sleeping, current-clock dependency, random input, or network access. The same input objects produce the same result. Input arrays and objects are not sorted or edited in place.

Every simulated step requires exactly one complete normalized quarter-hour price interval. Missing, duplicate, malformed, or hourly prices are rejected; the simulator does not fill gaps or synthesize quarters. Negative and zero SEK/kWh prices remain valid.

## Generic demo defaults

These values are illustrative defaults for a generic synthetic household only:

| Parameter | Demo value | Meaning |
| --- | ---: | --- |
| Indoor temperature | 21 °C | Initial house temperature |
| Summer outdoor temperature | 24 °C | Synthetic summer scenario |
| Winter outdoor temperature | 2 °C | Synthetic winter scenario |
| House heating power | 4 kW | Electrical input while enabled |
| Effective house heat capacity | 20 kWh/°C | Lumped temperature response |
| House heat-loss fraction | 0.01 per hour | Fraction of indoor/outdoor temperature difference lost per hour |
| Tank temperature | 48–50 °C | Initial synthetic tank temperature |
| Hot-water heater power | 2 kW | Electrical input while enabled |
| Effective tank heat capacity | 0.35 kWh/°C | Lumped storage response |
| Tank standing-loss fraction | 0.005 per hour | Fraction of tank/room temperature difference lost per hour |
| Hot-water room temperature | 20 °C | Reference temperature for standing loss |
| Synthetic draw | 1.4 kWh | Heat removed at a configured quarter-hour, representing a simple shower event |

The model treats thermal storage as a lumped temperature and capacity. House heat loss moves indoor temperature toward the supplied outdoor temperature; electrical heating adds stored heat according to power, step duration, and effective capacity. The tank uses the same simple energy/capacity relation, a proportional standing loss, and configurable draw events. It omits heat-pump efficiency, combustion, detailed building mass, plumbing, stratification, solar gain, occupancy, ventilation, and weather variation.

## Virtual controller and simulated local safety

The virtual controller applies `DesiredAction` entries from Core to simulated state. It can also demonstrate the distinction between price optimization and a local minimum-temperature policy. If the house drops below the configured demonstration threshold, the virtual controller forces simulated house heat until the threshold plus recovery margin is reached. The result counts each activation episode.

This is a simulator concept only. It is not a real-hardware safety specification, and its generic temperatures must not be treated as medical, hygiene, code, or installation advice. In particular, no hot-water temperature in the demo is represented as guaranteed Legionella-safe.

## Energy and cost

For a 15-minute step, enabled electrical power in kW is multiplied by 0.25 hours to produce kWh. The simulator separately totals house-heating kWh, hot-water kWh, and total kWh. When a normalized spot price is supplied, step cost is `step kWh × priceSekPerKwh`, and costs accumulate in SEK. Negative spot prices can produce negative modeled cost. Cost covers only the supplied spot-energy price; it does not add VAT, energy tax, retailer additions, or grid fees.

The Core block's `priceSumSekPerKwh` remains a sum of interval prices, not a bill. The simulator's monetary cost is calculated from energy consumed during each priced step.

## Included deterministic scenarios

`npm run demo` runs three fixed 24-hour synthetic scenarios:

- **SUMMER:** Core selects hot-water timing while Summer mode requests house heating off. The safety threshold is configured low enough that it does not intervene in this scenario.
- **WINTER:** Core requests house heating on while the house loses heat outdoors and hot water is scheduled.
- **EXPENSIVE PERIOD:** synthetic prices include an early cheaper block, a costly middle period, and a still cheaper later block. The Core planner chooses the later contiguous block; the simulator has no knowledge of which period is cheap.

Each scenario compares the Core-planned schedule with a fixed hot-water schedule at midnight. The comparison is illustrative and does not establish universal savings. Depending on temperatures, draw timing, price pattern, and settings, planning may not save money.

The structured TypeScript result reports the scenario window, step count, indoor/tank initial-final-minimum-maximum temperatures, system and total kWh, total modeled SEK cost, selected hot-water period, and local safety activations. The CLI prints a compact readable comparison.

## Run locally

With Node.js 24 or later and project dependencies installed:

```sh
npm test
npm run typecheck
npm run demo
```

The demo needs no credentials, internet, Cloudflare, production state, or physical hardware.

## Limitations

This first-order model exists to make plan flow and energy/cost units understandable. It is not a forecast, validated building simulation, equipment sizing tool, tariff calculator, or proof of household savings. Real safety behavior, equipment limits, local controller behavior, and hot-water requirements remain future work and must be defined for actual hardware independently.
