---
"radius-cli": minor
---

Add `wallet faucet` (alias `wallet faucet fund`/`drip`) and `wallet faucet status`: request test funds from the Radius faucet for the configured network and inspect its rate-limit state, through `radius-sdk/faucet`. Drips are unsigned first and the local wallet signs the faucet's EIP-191 challenge only when the faucet asks, so the keystore is unlocked only when needed; `--signature always|never`, `--token`, `--faucet-url` (also `RADIUS_FAUCET_URL` / `faucetUrl` in config.json) and `--json` are supported. Exit code 2 when the faucet declines for now (rate limited, empty, signature required for another address).
