# radius-sdk (PoC)

Accept and make [Radius](https://radiustech.xyz) payments over standard [x402 v2](https://x402.org).
Hono and Cloudflare Workers first. SBC is the default currency, mainnet the default network.

Status: not yet published to npm.

## Installation dependencies

For this unpublished preview, use the workspace examples (`pnpm install` at the repository
root, then `pnpm --filter radius-sdk build`). Once published, install the dependencies for
the entry point you use:

```sh
# Hono seller
pnpm add radius-sdk hono

# Buyer / agent (including applications that also accept payments)
pnpm add radius-sdk viem
```

Hono and viem are optional peer dependencies. The `radius-sdk/hono` entry point requires Hono;
`radius-sdk/client` requires viem `^2.48.11`. Root and Hono entry points do not load viem at
runtime. Network definitions remain compatible with viem's `Chain` type; TypeScript consumers
that resolve those declarations may also need viem installed for its types.

Applications already using a compatible viem version can use that installation for the SDK's
buyer client. The peer range makes this shared dependency explicit; applications using an
older or incompatible version need to update it.

This isolates runtime imports, not the installed dependency tree: `@x402/evm` currently depends
on viem itself, so package managers can still install a transitive copy. Buyer applications
should declare viem directly rather than rely on that copy being accessible. Deduplication
across the full dependency tree depends on compatible ranges and the package manager's resolution.

## Accept payments (seller)

```ts
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';

type Env = { Bindings: { PAY_TO: `0x${string}` }; Variables: RadiusPaymentVariables };
const app = new Hono<Env>();

app.use('/api/*', radiusPayments<Env>({
  network: 'testnet',                 // default 'mainnet'; or a custom instance, see below
  payTo: (c) => c.env.PAY_TO,         // or a literal address
  routes: {
    'GET /api/lookup': { price: '$0.001', description: 'One lookup' },
    'POST /api/query': '$0.01',                 // shorthand
    'GET /api/raw':    { price: { amount: '100' } },   // atomic units (6 decimals for SBC)
  },
}));

app.get('/api/lookup', (c) => c.json({ ok: true, paidBy: c.get('radiusPayment')?.payer }));
export default app;
```

What you get, on the wire, with no Radius-specific client knowledge required:

- Unpaid request → `402` with a `PAYMENT-REQUIRED` header: `exact` scheme, SBC via Permit2,
  `eip2612GasSponsoring` declared so first-time wallets need no on-chain approval.
- Paid request (`PAYMENT-SIGNATURE`) → settled on Radius through the Radius facilitator
  **before** your handler runs (`settle: 'after'` switches to the x402 default flow), then a
  `PAYMENT-RESPONSE` header with the transaction hash.
- `c.get('radiusPayment')` in the handler, and `onSettled(receipt, c)` for logging.
- `eip2612GasSponsoring` is declared only when the facilitator's `/supported` lists it
  (`gasSponsoring: true | false` overrides), so clients never send a permit nobody will honour.
- No I/O at module scope (Workers-safe): the facilitator's `/supported` is fetched lazily on the
  first paid request after each cold start. Server bundle is ~65 KiB gzipped, no viem.

Verified with stock `radius-cli wallet x402` 0.1.5 paying a local `wrangler dev` worker on testnet.

## Make payments (buyer / agent)

```ts
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from 'radius-sdk/client';

const payFetch = createRadiusFetch({
  network: 'testnet',
  signer: process.env.RADIUS_PRIVATE_KEY,   // or any viem account / { address, signTypedData }
  maxPerRequest: '$0.05',                   // required, hard per-request ceiling
  onPaymentRequired: (offer) => offer.payTo === TRUSTED_SELLER,   // optional approve/decline hook
});

const res = await payFetch('https://seller.example/api/lookup?ip=1.2.3.4');
const receipt = getPaymentReceipt(res, payFetch.network);   // { success, transaction, payer, explorerUrl, … }
```

- Pays only on the configured network and asset; anything else throws a `RadiusPaymentError`
  with a `code` (`network_mismatch`, `asset_mismatch`, `no_compatible_offer`, `price_above_limit`,
  `declined`, `payment_rejected`, …) before anything is signed. Of the compatible offers the first
  one within `maxPerRequest` is taken, in the server's order (its preference), the same as
  `radius-cli`. `payment_rejected` and `invalid_challenge` carry the server's `Response` in
  `details.response` so you can log what it said.
- The signing window (`validBefore` / Permit2 `deadline`) is the server's `maxTimeoutSeconds`
  capped at 600 s: an authorisation the facilitator never settles stays redeemable until then.
- Schemes, a superset of what `radius-cli wallet x402` pays: x402 v2 `exact` (Permit2 or EIP-3009)
  and `upto` (Permit2 via the x402UptoPermit2Proxy, witness bound to the facilitator address the
  402 names), plus x402 v1 `exact` (EIP-3009, challenge in the JSON body, payment in `X-PAYMENT`).
  The offer passed to `onPaymentRequired` says which (`offer.scheme`, `offer.x402Version`). For
  `upto`, `offer.amount` and `maxPerRequest` are about the authorised maximum; the receipt carries
  the amount actually charged, which is validated against the signed maximum (`invalid_receipt`
  otherwise). The Radius facilitator does not advertise `upto` yet, so it is unit-tested only.
- Redirects: the paid retry is sent with `redirect: 'manual'`. A 3xx to another origin throws
  `redirect_refused` without following (the payment header is never replayed elsewhere); a
  same-origin 3xx is returned as-is, unfollowed, so you decide whether to re-request (and pay
  again). In browsers this surfaces as an opaque redirect response (status 0).
- Permit2 approval handled either way: when the server's facilitator sponsors it
  (`eip2612GasSponsoring`), a wallet holding only SBC pays without any on-chain transaction; when
  it does not, the SDK sends one unlimited approval from the signer (`permit2Approval: 'auto'`,
  the default; `'never'` throws `approval_required`; `onApprovalRequired` can veto). Gas for that
  one transaction comes from SBC via Turnstile, so keep ~0.01 SBC spare.
- `maxPerRequest` is a per-request ceiling, **not** a cumulative budget. An agent that loops can
  exceed any total unless you enforce one around it.
- Wallet helpers on the same object: `address`, `balance()` (SBC only), `balances()` (native RUSD,
  SBC and the aggregate, separately; see [Balances](#balances-native-rusd-vs-stablecoins)),
  `send(to, '$0.05')`, `permit2Allowance()`, `approvePermit2()`, `getSettlement(txHash)` to
  reconcile a payment on-chain before charging again, `fund()` for a faucet drip (testnet ~0.5 SBC,
  mainnet ~0.01 SBC/day) with `faucet` (the faucet client, see [Faucet](#faucet-test-funds)) for
  its status, and `client` (the underlying `@x402/core` client).
- Config from the environment with radius-cli's variable names:
  `createRadiusFetch({ ...radiusEnv(process.env), signer })` reads `RADIUS_NETWORK`,
  `RADIUS_RPC_URL`, `RADIUS_FACILITATOR_URL`, `RADIUS_FAUCET_URL`, `RADIUS_SWAP_URL`, `RADIUS_ASSET_ADDRESS` (alias `RADIUS_SBC_ADDRESS`), `RADIUS_PRIVATE_KEY`,
  `RADIUS_MAX_PER_REQUEST`; on Workers pass `c.env`.

## Balances: native RUSD vs stablecoins

Radius differs from other EVM chains here. `eth_getBalance` (viem's `getBalance`, MetaMask's
balance, `cast balance`) returns the account's native RUSD **plus** its convertible stablecoin
holdings (SBC) valued 1:1 and rescaled to 18 decimals: the total the account can spend, since
the Turnstile converts SBC into RUSD inline when a transaction needs it. Reading `eth_getBalance`
and an SBC `balanceOf` and adding them double-counts the SBC. The EVM itself is unchanged: the
`BALANCE` opcode (Solidity's `address.balance`) sees only the native amount.

The SDK reports each part on its own, as plain viem actions or as a client extension. They are
exported from `radius-sdk/client` (the entry point that requires viem); the root entry point
keeps only their types:

```ts
import { createPublicClient, http } from 'viem';
import { radiusTestnet, SBC } from 'radius-sdk';
import { radiusActions, getBalances, getNativeBalance, getTokenBalance } from 'radius-sdk/client';

const client = createPublicClient({ chain: radiusTestnet.chain, transport: http() }).extend(radiusActions());

const b = await client.getBalances({ address });
b.native.raw            // 2345678000000000000n  — native RUSD only (wei)
b.native.aggregate      // 12345678000000000000n — what eth_getBalance / client.getBalance() returns
b.native.convertible    // 10000000000000000000n — aggregate − raw: SBC value the Turnstile can convert
b.tokens[0]             // { symbol: 'SBC', atomic: 10000000n, formatted: '10', decimals: 6, convertible: true, … }
b.totalFormatted        // '12.345678' — raw + convertible tokens at 1:1, 18 decimals

// Individually, or without the extension:
await client.getNativeBalance({ address });                    // bigint, native RUSD only
await client.getTokenBalance({ address, token: SBC });         // raw ERC-20 balanceOf
await getNativeBalance(client, { address });                   // same actions, viem style
await getBalances(client, { address, tokens: [SBC, { address: '0x…', symbol: 'USDX', decimals: 18 }] });
```

`getBalances` issues one `eth_getBalance`, one `eth_call` per token and one `eth_call` for the
native balance, in parallel, and accepts `blockNumber` / `blockTag`. Default tokens are the
network's payment asset (SBC), chosen from the client's chain id (or a `network` option).

How the raw native balance is read: an `eth_call` with no `to` whose init code is
`PUSH20 <address> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`, so it needs no deployed
contract and works on any node that executes standard EVM. `b.native.rawSource` says `evm` when
that succeeded. Should a node refuse the call, `getBalances` falls back to subtracting the
`convertible` tokens from the aggregate (`rawSource: 'derived'`, with the error in `rawError`);
`nativeBalance: 'evm' | 'derived' | 'auto'` selects the strategy explicitly. Mark extra tokens
`convertible: true` only if the Turnstile counts them in `eth_getBalance` (today: SBC); other
tokens are reported in `tokens` but not valued 1:1 in `total`.

## Faucet (test funds)

A typed client for the Radius faucet API as described by its OpenAPI document
(`<faucetUrl>/openapi.json`, e.g. https://testnet.radiustech.xyz/api/v1/faucet/openapi.json):
`GET /status/{address}`, `GET /challenge/{address}` and `POST /drip`.

```ts
import { createFaucetClient, FaucetError } from 'radius-sdk/faucet';
import { privateKeyToAccount } from 'viem/accounts';

const faucet = createFaucetClient({ network: 'testnet' });       // or { url: 'https://…/api/v1/faucet' }
const account = privateKeyToAccount(process.env.RADIUS_PRIVATE_KEY);

await faucet.status(account.address);      // { rateLimited, retryAfterMs?, remainingRequests, dripAmount: '0.5', … }
const drip = await faucet.fund(account.address, { signer: account });   // { success: true, amount, txHash, explorerUrl }

try { await faucet.fund(account.address, { signer: account }); }
catch (e) { if (e instanceof FaucetError && e.faucetCode === 'rate_limited') console.log(`retry in ${e.retryAfterMs} ms`); }
```

- `fund()` drips unsigned first and, if the faucet answers `signature_required`, signs the EIP-191
  challenge (taken from the error's `details.challenge`, else `GET /challenge`) with
  `signer.signMessage` (any viem local account) and drips again; one retry on `invalid_signature`
  with a fresh challenge. Testnet currently drips unsigned, mainnet is
  expected to require signatures, and the switch can flip at any time, so the fallback is always
  on. `{ signature: 'always' }` skips the unsigned attempt, `'never'` disables the fallback; without
  a signer a signature demand throws `signer_required`. `status()`, `challenge()` and `drip()` are
  the raw endpoints.
- Errors are `FaucetError` (a `RadiusPaymentError` with `code: 'faucet'`) decoded from the Radius
  API envelope `{ error: { code, message, request_id, retry_after_ms?, details? } }`: `faucetCode`
  (`signature_required`, `invalid_signature`, `rate_limited`, `faucet_empty`, `transaction_reverted`,
  `receipt_timeout`, `native_drip_failed`, `internal_error`, …), the HTTP `status`, `retryAfterMs`,
  `requestId`, code-specific `errorDetails` (e.g. the `tx_hash` of a reverted drip) and the raw body
  in `details`. Response text is treated as data: only the documented fields are read.
- Where the faucet is configured to, a drip also sends a little native RUSD for gas as a second
  transaction (`drip.native`, `status.nativeDripAmount`).
- `createRadiusFetch(…).fund()` is this flow for the signer's address on the configured network
  (`faucetUrl` override for a same-origin proxy, as the demo dapp does for CORS), and
  `createRadiusFetch(…).faucet` is the client itself.
- Token defaults to the network's payment asset symbol (SBC); `token` overrides it. The client has
  no viem dependency and is Workers- and browser-safe (no I/O at module scope).

## Swap (move SBC/USDC between Radius and Base or Ethereum)

A typed client for the Radius Swap API as described by its OpenAPI document
(`<swapUrl>/openapi.json`, e.g. https://testnet.radiustech.xyz/api/v1/swap/openapi.json). The API
moves stablecoins across chains through Brale: you sign an EIP-712 `SwapIntent`, the API returns an
exact unsigned ERC-20 transfer on the source chain, you sign it unchanged, the API broadcasts it and
runs the swap; the destination payout follows.

```ts
import { createSwapClient, SwapError } from 'radius-sdk/swap';
import { privateKeyToAccount } from 'viem/accounts';

const swap = createSwapClient({ network: 'testnet' });    // or { url: 'https://…/api/v1/swap' }
const account = privateKeyToAccount(process.env.RADIUS_PRIVATE_KEY);   // must hold the source token AND source-chain gas

console.log(await swap.routes());   // [{ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', sourceChainId: 84532, … }]

try {
  const { broadcast, status } = await swap.swap(
    { sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1.5' },
    account,                                       // destinationAddress defaults to the signer
    { wait: { untilPayout: true, onStatus: (s) => console.log(s.status) } },
  );
  console.log(broadcast.sessionId, broadcast.txHash, status?.payoutTx);
} catch (e) {
  if (e instanceof SwapError) console.error(e.swapCode, e.message, e.requestId);   // e.g. INSUFFICIENT_GAS, ACTIVE_PREPARED_TX_EXISTS, SWAP_FAILED
}
```

- `swap()` is `prepare()` → `signPrepared()` → `broadcast()` → `waitForCompletion()`; each step is
  public for agents that want to checkpoint between them (`prepared.swapToken` is single-use for
  broadcast; `broadcast.swapToken` reads the session). `prepare()` resolves the route from
  `GET /instructions` (cached), signs `SwapIntent` with the source chain's id in the EIP-712 domain
  and the deployment's `environment`, and defaults `destinationAddress` to the signer,
  `idempotencyKey` to a random `idem_…`, `expiresAt` to five minutes. `amount` is a decimal string
  ("1.5"), signed as-is.
- The signer must `signTypedData` and, for `signPrepared()` / `swap()`, `signTransaction`: a private
  key or viem local account. Injected wallets cannot sign a raw transaction, so in a browser use
  `prepare()` and submit the prepared transfer another way. `unsignedTx` is hex quantities on the
  wire; `toSignableTransaction()` decodes them for viem without changing a value.
- `waitForCompletion()` polls `status()` every 3 s (the API's floor) until `complete` / `failed` /
  `expired`, optionally `untilPayout` (the destination `payoutTx` can land shortly after
  `complete`), and throws `TIMEOUT` after 10 minutes by default. `swap()` throws `SWAP_FAILED` with
  the final status in `details` when a session fails.
- Recovery: `sessionListToken(account)` signs `SwapSessionListAccess` for a wallet-scoped token and
  `listSessions(token, { status, cursor, … })` returns durable sessions plus active prepared swaps,
  each with a fresh token, so a lost response or expired token never strands a swap.
- Errors are `SwapError` (a `RadiusPaymentError` with `code: 'swap'`) decoded from the Radius API
  envelope: the API's `swapCode` (`INVALID_SIGNATURE`, `INSUFFICIENT_SOURCE_TOKEN`,
  `INSUFFICIENT_GAS`, `ACTIVE_PREPARED_TX_EXISTS`, `TOKEN_EXPIRED`, `RATE_LIMITED`, …), HTTP
  `status`, `requestId`, `retryAfterMs`, `errorDetails` and the raw body in `details`.
  `instructions().errorCodes` carries the API's own description and recommended action per code.
- `createRadiusFetch(…).swap` is this client for the buyer's network; `RADIUS_SWAP_URL` /
  `swapUrl` override the URL. Testnet routes: Base Sepolia SBC ↔ Radius testnet SBC, Sepolia SBC →
  Radius testnet SBC; mainnet: Base / Ethereum USDC ↔ Radius SBC.

## Networks and currency

```ts
import { radiusMainnet, radiusTestnet, radiusMainnetChain, radiusTestnetChain, defineRadiusNetwork, resolveNetwork } from 'radius-sdk';
import { createPublicClient, http } from 'viem';

resolveNetwork('testnet', { rpcUrl: 'https://rpc.testnet.radiustech.xyz/YOUR_KEY' });
defineRadiusNetwork({ chainId: 4242, rpcUrl, facilitatorUrl, asset: { address: '0x…', symbol: 'USDX' } });
defineRadiusNetwork({ chain: myViemChain, facilitatorUrl });   // or start from a viem Chain

// Every RadiusNetwork carries its viem Chain; use it for your own viem clients.
createPublicClient({ chain: radiusTestnet.chain, transport: http() });
```

Chain identity lives in viem `Chain` objects: `radiusMainnetChain` (id 723487) and
`radiusTestnetChain` (id 72344), native currency RUSD, defined here with the same values as
viem's `radius` / `radiusTestnet` (importing `viem/chains` would load every chain viem knows). A `RadiusNetwork` is one of those
chains (`network.chain`, the source of truth) plus the Radius-specific `facilitatorUrl`,
`faucetUrl`, `swapUrl` and `asset`; `chainId`, `network` (CAIP-2 `eip155:<id>`), `rpcUrl`, `explorerUrl`
and `testnet` are derived from the chain. An `rpcUrl` override yields a network whose `chain`
also uses that RPC.

Both `radiusPayments` and `createRadiusFetch` accept `network`, plus `rpcUrl`, `facilitatorUrl`,
and `asset` overrides. The asset defaults to SBC (6 decimals, permit domain "Stable Coin" v1);
prices in USD strings assume a USD-pegged asset.

**Facilitator.** Defaults to the Radius facilitator for the network, with a live `/supported`
lookup. Options: `facilitator: { url, apiKey }` for another hosted facilitator,
`facilitator: { live: false }` to skip the lookup and use the built-in Radius answer (faster cold
start, but stale if the facilitator changes), or `facilitator: myClient` where `myClient`
implements `FacilitatorClient` from `@x402/core/server` (`getSupported`, `verify`, `settle`) for a
self-hosted facilitator with your own auth or routing.

## Layout

| Path | What |
| --- | --- |
| `src/` | `networks`, `balances`, `amounts`, `receipt`, `errors`, `faucet`, `swap`; `hono/` (server); `client/` (buyer) |
| `examples/worker-seller` | Hono worker: free `/`, paid `/api/lookup` and `/api/query` (`pnpm dev`) |
| `examples/agent-buyer` | `buy.mjs` (pay a URL), `fund.mjs` (faucet drip + status), `swap.mjs` (cross-chain swap into or out of Radius), `fresh-wallet.mjs` (gasless proof from a new wallet, faucet-funded) |
| `examples/demo-dapp` | Test-dapp style page exercising both sides in the browser (burner wallet or MetaMask) |
| `test/` | unit tests (facilitator, RPC, faucet and swap API mocked; `client-parity.test.ts` pins the wire format against radius-cli's; `balances.test.ts` runs the native-balance init code in a real EVM); `test/e2e` real settlement and a live balance reconciliation on testnet or mainnet (`RADIUS_E2E=1 RADIUS_PRIVATE_KEY=… [RADIUS_NETWORK=mainnet] pnpm test:e2e`) |

Built on `@x402/core` (server and client), `@x402/evm` (client signing only) and viem.
