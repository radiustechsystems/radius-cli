# radius-sdk

## 0.1.0

### Minor Changes

- 94add33: Add balance queries that separate native RUSD from convertible stablecoin holdings: `getBalances`, `getNativeBalance`, `getAggregateBalance`, `getTokenBalance` and the `radiusActions()` client extension, exported from `radius-sdk/client`.

### Patch Changes

- d966811: Make viem an optional peer dependency so buyer applications can supply their existing compatible installation. Remove its runtime import from shared network definitions so root and Hono seller imports no longer load viem. Document entry-point dependencies and add runtime import-isolation checks. Upstream x402 dependencies can still install viem transitively.
