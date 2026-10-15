---
'radius-cli': minor
---

`wallet fund` requests a testnet SBC drip from the Radius faucet for the local wallet through the SDK's `fund()` (challenge, EIP-191 signature, drip), so scripts no longer chain `wallet sign -` and `curl`. Testnet only; `--faucet-url` overrides the faucet API and `--json` prints `{address, network, token, amount, txHash, explorerUrl}`.
