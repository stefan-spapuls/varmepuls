# VärmePuls

VärmePuls is an open-source energy optimization project for electric home heating and domestic hot water using Swedish electricity prices.

**Status: under active development.** Price planning, isolated Cloud foundations, device-authentication code, and a hardware-free simulator exist. Real heating hardware is not supported, and no real device trusts or obeys the Cloud service.

## Implemented today

- Swedish electricity zones SE1–SE4 with validated 15-minute spot-price intervals in SEK/kWh.
- Deterministic planning of the cheapest contiguous hot-water period, with Summer and Winter modes.
- A read-only ElprisetJustNu price adapter; automated tests use synthetic/offline data.
- An isolated Cloud Worker/D1 foundation with configuration and immutable plan storage, plus device-authentication routes. Synthetic remote authentication qualification passed for enrollment, signed reads, replay resistance, isolation, rotation, and revocation. The remote plan payload read remains to be qualified with a legitimate demo plan.
- A deterministic 15-minute virtual house and hot-water model, including energy and modeled spot-cost accounting.
- Three offline demo scenarios comparing Core-planned hot-water timing with a fixed-time baseline.

The Cloud foundation is not connected to real equipment and has **zero real heating authority**. See [Cloud architecture](docs/CLOUD_ARCHITECTURE.md), [authentication design](docs/AUTHENTICATION.md), and [Cloud deployment notes](docs/CLOUD_DEPLOYMENT.md).

## Planned / not yet implemented

- Real heating, boiler, relay, or other hardware integration.
- A production household deployment or a controller paired to the Cloud service.
- Home Assistant, Tado, or mobile application support.
- Adaptive heating, an automatic scheduling service, or a scheduled price refresh.
- A finished user interface or a full consumer electricity-bill model.

## Hardware-free quick start

Requires Node.js 24 or later. After cloning the repository, run these commands from its root:

```sh
npm install
npm test
npm run typecheck
npm run demo
```

The automated tests are deterministic and offline. The demo needs no credentials, internet access, Cloudflare account, or physical heating equipment.

## Demo

`npm run demo` runs synthetic 24-hour Summer, Winter, and expensive-period scenarios. The existing Core planner chooses flexible hot-water timing; the virtual controller applies the resulting logical actions to the same simple physical model used for a fixed-time comparison. Output includes indoor and tank temperatures, house and hot-water kWh, total kWh, and modeled cost in SEK.

These generic demo inputs are not measurements of a real home. Cost comparisons are examples, not promises of savings. Read [simulator assumptions and limitations](docs/SIMULATOR.md).

## Architecture

```text
ElprisetJustNu or synthetic prices
                ↓
       provider adapter and validation
                ↓
          normalized price intervals
                ↓
          deterministic Core planner
                ↓
       logical plan and desired actions
          ↙                    ↘
virtual controller and model     isolated Cloud API and D1
          ↓                       configuration, plan revisions,
virtual house + hot water         and device identity/authentication
          ↓                       (no real device is paired)
energy kWh + modeled SEK cost
```

The Core planner operates on normalized prices and returns logical actions. Provider, Cloud, and device concerns stay outside the planner. The simulator consumes those same actions; it is not a second planner.

Future physical integrations will require an equipment-specific local controller and safety handling. Current demo and Cloud behavior do not control real heating equipment.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Core MVP](docs/MVP.md)
- [Price-provider contract](docs/PRICE_PROVIDER.md)
- [ElprisetJustNu adapter](docs/ELPRISETJUSTNU.md)
- [Cloud architecture](docs/CLOUD_ARCHITECTURE.md)
- [Cloud deployment notes](docs/CLOUD_DEPLOYMENT.md)
- [Authentication design](docs/AUTHENTICATION.md)
- [Authentication feasibility evidence](docs/AUTHENTICATION_FEASIBILITY.md)
- [Local authentication qualification](docs/AUTHENTICATION_LOCAL_QUALIFICATION.md)
- [Hardware-free simulator](docs/SIMULATOR.md)
- [Roadmap](docs/ROADMAP.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, checks, and project safety boundaries. Do not put real household data, device credentials, private configuration, or production identifiers in source, fixtures, logs, or pull requests.

## Security

See [SECURITY.md](SECURITY.md) to report security-sensitive vulnerabilities privately. Do not post vulnerability details publicly.

## License

VärmePuls is released under the [Apache License 2.0](LICENSE). Project attribution is in [NOTICE](NOTICE).
