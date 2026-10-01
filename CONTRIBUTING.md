# Contributing to VärmePuls

Thanks for helping improve VärmePuls. The project is under active development; changes should keep the deterministic Core small, explicit, and independent of hardware.

## Set up locally

Use Node.js 24 or later. From the repository root:

```sh
npm install
npm test
npm run typecheck
npm run demo
```

Tests and the demo use synthetic inputs and do not require internet, credentials, Cloudflare access, or hardware. `npm ci` is suitable when you want the exact dependency versions from `package-lock.json`.

## Before proposing a change

- Read [the architecture](docs/ARCHITECTURE.md), [the MVP boundaries](docs/MVP.md), and any relevant feature documentation.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Possible violations can be reported privately using the contact listed there.
- Keep the Core planner deterministic and independent of HTTP, providers, Cloudflare, clocks, and device commands.
- Preserve explicit units, such as `priceSekPerKwh`, `energyKwh`, `powerKw`, and `temperatureC`.
- Add focused offline tests for behavior changes. Use synthetic price, household, and identity data only.
- Run the full test suite, strict type checks, and the demo after changing relevant code.

## Safety and privacy

- Do not add hardware-control behavior or treat Cloud plans as sufficient authorization to operate equipment.
- Do not contact real controllers, create production data or credentials, deploy, or alter Cloud resources as part of a code contribution.
- Never commit real household data, local addresses, device identifiers, tokens, private keys, enrollment capabilities, production database identifiers, local Wrangler configuration, or logs.
- Do not copy code, configuration, data, or credentials from unrelated projects.
- Keep examples and fixtures clearly synthetic. Do not claim the simulator models a particular house or guarantees savings or hot-water safety.

## Pull requests

Explain the user-visible or architectural change, note any safety/privacy implications, and include the checks you ran. Keep changes scoped; defer speculative infrastructure and features until a concrete requirement exists.

Contributions are made under the [Apache License 2.0](LICENSE), subject to its terms. No separate contribution agreement is currently required.
