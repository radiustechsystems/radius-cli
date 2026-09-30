---
"radius-sdk": minor
---

Add createEvmFetch for x402 purchases across explicitly configured EVM networks and ERC-20 assets, using the upstream x402 multi-network registry and lifecycle hooks, with independent spending caps, chain-specific signers and settlement reconciliation. Unsponsored Permit2 approval is opt-in. Preserve createRadiusFetch and its Radius wallet helpers; reject receipts that name a different payment network.
