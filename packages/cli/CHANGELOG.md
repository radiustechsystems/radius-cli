# radius-cli

## 0.2.1

### Patch Changes

- fd86bf6: README: SBC has a built-in default address (from `radius-sdk`); `--sbc` / `RADIUS_SBC_ADDRESS` are only needed for another deployment.
- Updated dependencies [fd86bf6]
- Updated dependencies [2dae8ec]
  - radius-sdk@0.2.0

## 0.2.0

### Minor Changes

- ed17f69: `wallet x402` now pays through `radius-sdk`: Permit2 approvals are gas-sponsored when the server declares `eip2612GasSponsoring`, payments are in SBC only on the configured network, the keystore is unlocked only after a 402 has been parsed and matched, and `--x402-approve-permit2` grants an approval even when sponsored. `--x402-threshold` is now a hard cap even with `--yes`: an offer above it is refused (exit 2) instead of paid; drop the threshold to let `--yes` pay any amount. The hand-rolled x402 client is gone.

### Patch Changes

- 129d8cc: Point the package's `repository`, `homepage` and `bugs` metadata at github.com/radiustechsystems/radius-cli (it named a non-existent `radiustech` org). npm provenance requires `repository.url` to match the repository the package is published from.
- Updated dependencies [94add33]
- Updated dependencies [d966811]
  - radius-sdk@0.1.0
