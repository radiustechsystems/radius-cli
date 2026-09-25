# radius-sdk

## 0.2.0

### Minor Changes

- 2dae8ec: Add ERC-20 interactions as viem actions, exported from `radius-sdk/client`: `getTokenMetadata`, `getAllowance`, `approve`, `transfer`, `transferFrom`, `getTransfers`, `watchTransfers` and the `erc20Actions({ token?, network? })` client extension. The default token is the payment asset of the client's chain when it is a Radius preset, or of `network`; any other chain must name a `token` (a `config` error, never a silent SBC address). Writes wait for the receipt; `wait: false` returns `status: 'pending'` (`TxResult.status` is now `'pending' | 'success' | 'reverted'`). `getTransfers` defaults to the last `MAX_LOG_RANGE` (1e6) blocks and splits wider ranges into sequential `eth_getLogs` calls; `watchTransfers` is an SDK poller with a resumable `fromBlock`, ordered at-least-once delivery, `onCheckpoint`, retry without gaps, and `transferKey` as the dedupe key. `createRadiusFetch(...)` gains `allowance(spender)` and `approve(spender, amount)`; every allowance change it makes (payment-time Permit2 approval, `approvePermit2()`, `approve()`) now passes through `onApprovalRequired`, whose `ApprovalRequest` carries a `reason` and an optional `offer`.

### Patch Changes

- fd86bf6: README: drop the PoC and unpublished-preview wording, add an entry-point table, and list every `src/` module.

## 0.1.0

### Minor Changes

- 94add33: Add balance queries that separate native RUSD from convertible stablecoin holdings: `getBalances`, `getNativeBalance`, `getAggregateBalance`, `getTokenBalance` and the `radiusActions()` client extension, exported from `radius-sdk/client`.

### Patch Changes

- d966811: Make viem an optional peer dependency so buyer applications can supply their existing compatible installation. Remove its runtime import from shared network definitions so root and Hono seller imports no longer load viem. Document entry-point dependencies and add runtime import-isolation checks. Upstream x402 dependencies can still install viem transitively.
