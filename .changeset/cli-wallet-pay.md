---
'radius-cli': minor
---

`wallet x402` is renamed `wallet pay` and can pay in USDC on Base: `--networks radius,base` (or `RADIUS_PAY_NETWORKS` / `payNetworks` in the config file) lists the networks to pay on, in preference order, and `--network testnet` pairs Radius testnet with Base Sepolia. Base RPCs are set with `RADIUS_BASE_RPC_URL` / `RADIUS_BASE_SEPOLIA_RPC_URL` or `rpcUrls.base` / `rpcUrls["base-sepolia"]`. `--x402-threshold` and `--x402-approve-permit2` are renamed `--threshold` and `--approve-permit2`, prompts and messages name the network and its token, and the JSON `payment` object gains `network`.
