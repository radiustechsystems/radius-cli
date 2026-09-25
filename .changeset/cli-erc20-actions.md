---
"radius-cli": minor
---

`wallet` runs its ERC-20 interactions on `radius-sdk/client`'s `erc20Actions` and balance actions. `wallet send <to> <amount> 0xToken` transfers any ERC-20 (decimals read on-chain), next to `SBC` and `RUSD`. `wallet balance` now reports native RUSD and SBC separately instead of adding SBC to the aggregate `eth_getBalance` (which already includes it), so `totalUsd` no longer double counts; the JSON gains `aggregateWei` and `rusdSource`.
