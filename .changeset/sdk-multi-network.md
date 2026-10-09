---
'radius-sdk': minor
---

Pay and charge on more than one network. Networks are now `PaymentNetwork`s (was `RadiusNetwork`), built with `definePaymentNetwork({ chain, asset })` (was `defineRadiusNetwork`), with presets for Radius (`'radius'` / `'mainnet'`, `'radius-testnet'` / `'testnet'`), Base (`'base'`) and Base Sepolia (`'base-sepolia'`), both paying in USDC. Preset `name`s are now the preset ids (`'radius'`, `'radius-testnet'`), and `radiusNetworkForChainId` is `presetForChainId`.

`createRadiusFetch({ networks: [...] })` pays on any of the listed networks, preferring them in order; `offer.network` and `ApprovalRequest.network` are the `PaymentNetwork` paid on, a USD `maxPerRequest` is converted per asset, and `payFetch.on(network)` gives the wallet helpers for each network. x402 v1 challenges that name a network (`base`, `base-sepolia`) are matched too.

`radiusPayments({ networks: [...] })` / `createRadiusServer` offer one payment option per network on every route, each settled by its own facilitator (`{ network, facilitator }`); Base mainnet has no default facilitator, so sellers name one, and Base Sepolia defaults to x402.org. Receipts and `onSettled` report the network a payment settled on. When a facilitator's `/supported` names no transfer method, `exact` offers now default to EIP-3009 (x402's default) instead of Permit2.
