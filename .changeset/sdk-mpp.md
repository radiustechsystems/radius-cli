---
'radius-sdk': minor
---

MPP (the HTTP `Payment` auth scheme, `evm` charge method) alongside x402.

Buyers: `createRadiusFetch` pays `WWW-Authenticate: Payment` challenges with an EIP-3009 authorization bound to the challenge, in the `Authorization: Payment` credential mppx and other MPP servers expect, and reads `Payment-Receipt`. `protocols` (default `['x402', 'mpp']`) sets the preference when a 402 offers both. `PaymentOffer` is now `X402Offer | MppOffer`, told apart by `offer.protocol`; `requirements` and `x402Version` exist on x402 offers only. `PaymentReceipt` gains `protocol`, and `getPaymentReceipt` also reads `Payment-Receipt`.

Sellers: `radiusPayments({ mpp: { secretKey } })` adds an MPP challenge per network to every 402, mirroring the x402 offers, and accepts MPP credentials: checked statelessly (HMAC challenge id, realm, expiry, route price, nonce binding), then verified and settled by the network's x402 facilitator, before or after the handler per `settle`. Responses carry `Payment-Receipt`; the handler and `onSettled` get receipts with `protocol: 'mpp'`. Not available through the upstream x402 framework adapters.
