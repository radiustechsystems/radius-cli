---
'radius-cli': minor
---

`wallet sign-typed-data` signs EIP-712 typed data (`eth_signTypedData_v4` JSON from a literal, `@path` or stdin; integers as numbers, decimal or hex strings) and `wallet sign-jwt` signs a compact `ES256K` JWT with the wallet key (defaults: `iat` now, `exp` +300 s, `iss` `did:pkh:eip155:<chainId>:<address>`, `kid` `<iss>#controller`; `--iss`, `--kid`, `--expires-in`), so agents no longer export the private key to sign A2A tokens.
