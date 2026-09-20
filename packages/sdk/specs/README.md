# API specifications

OpenAPI 3.1 documents for the Radius HTTP APIs the SDK speaks, copied verbatim from
[`radiustechsystems/api-monorepo`](https://github.com/radiustechsystems/api-monorepo):

| File | Source in the monorepo | Live copy |
| --- | --- | --- |
| `faucet.openapi.json` | `apps/faucet-api/openapi/openapi.json` | `https://testnet.radiustech.xyz/api/v1/faucet/openapi.json` |
| `swap.openapi.json` | `apps/swap-api/openapi/openapi.json` | `https://testnet.radiustech.xyz/api/v1/swap/openapi.json` |

`src/generated/*.ts` is generated from them (`pnpm generate:api`, [openapi-typescript](https://openapi-ts.dev));
`src/faucet.ts` and `src/swap.ts` are hand-written on top and import their wire types from there.
Do not edit either the specs or the generated files by hand.

## How they update

1. A merge to the monorepo's `main` that changes a spec runs its `notify-api-clients` workflow,
   which sends an `api-spec-updated` `repository_dispatch` to this repository.
2. `.github/workflows/regenerate-api-clients.yml` checks the monorepo out at that commit, runs
   `pnpm sync:api-specs` and `pnpm generate:api`, typechecks, tests, and opens or refreshes the PR
   on the `bot/api-clients` branch. A failing typecheck or test means the spec changed in a way the
   hand-written layer must follow; the PR opens anyway, red, so it is visible.
3. The same workflow runs weekly and on demand (`workflow_dispatch`, optionally with a monorepo ref)
   as a safety net.

Locally, with a monorepo checkout next to this one:

```sh
pnpm --filter radius-sdk sync:api-specs ../api-monorepo
pnpm --filter radius-sdk generate:api
pnpm --filter radius-sdk typecheck && pnpm --filter radius-sdk test
```

CI runs `pnpm check:api`, which fails when `src/generated` is stale relative to `specs/`, and
`test/contract.test.ts`, which checks that every endpoint the clients call is documented (and every
documented one is used), that the unit-test fixtures only carry documented fields, and that the error
codes the clients branch on exist.
