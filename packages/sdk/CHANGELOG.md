# radius-sdk

## 0.4.0

### Minor Changes

- bdd6d76: Accept payments from any HTTP stack, not just Hono. New `radius-sdk/server` entry point:
  
  - `radiusPayments()` is a web-standard handler (`Request` in, `Response` out) for Cloudflare Workers without a framework, Bun, Deno, Node 18+, and Next.js / SvelteKit / Remix route handlers. Paid handlers receive the settled receipt as a second argument.
  - `createRadiusServer()` exposes the Radius x402 resource server and a `routes()` builder that plug straight into the upstream adapters: `paymentMiddleware(radius.routes({ … }), radius.server)` with `@x402/express`, `@x402/next` or `@x402/hono`.
  - `onSettled` is registered on the resource server, so it fires whichever adapter served the request (it receives the x402 request context; `requestOf(context)` returns the `Request` for the SDK's own adapters). Errors thrown by `onSettled` are logged by x402 core instead of failing the request.
  - Paid responses stream through in the default `settle: 'before'` flow instead of being buffered (the previous Hono middleware buffered every paid response, stalling SSE and token streams).
  - **Breaking:** `radius-sdk/hono` is now a thin wrapper over the web-standard handler with the same options. `RadiusHonoAdapter` is removed; `RequestAdapter` from `radius-sdk/server` (an x402 `HTTPAdapter` over a web-standard `Request`) replaces it.
  - `@x402/core` / `@x402/evm` bumped to 2.27.0 (the version line the upstream adapters require).
  - New examples: `examples/worker-plain` (no framework), `examples/express-seller` (`@x402/express`) and `examples/astro-seller` (validate before charging in an Astro API route).

### Patch Changes

- 23f73d6: `radiusPayments` accepts facilitators that list the `eip3009` transfer method for `exact`. Previously every paid route answered 500 once the facilitator's `/supported` named `eip3009` before `permit2`.
- 5a915b2: `radiusPayments` answers `502` (`facilitator_error`) when a facilitator call fails without the facilitator's own answer, such as a dropped connection or an error page from a gateway. These were reported as `402`, which a buyer reads as "rejected, nothing moved", although a settle may have reached the chain. The facilitator's own rejections are still `402`.

## 0.3.0

### Minor Changes

- c504f65: Add Permit2 interactions covering both SignatureTransfer (with optional witness) and AllowanceTransfer: `approvePermit2`, `signPermit2Transfer`, `permit2TransferFrom`, `signPermit2Allowance`, `permit2Permit`, `permit2AllowanceTransferFrom`, the `permit2Actions()` client extension and the EIP-712 helpers, exported from `radius-sdk/client`.

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
