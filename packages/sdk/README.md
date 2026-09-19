# radius-sdk (PoC)

Accept and make [Radius](https://radiustech.xyz) payments over standard [x402 v2](https://x402.org).
Hono and Cloudflare Workers first. SBC is the default currency, mainnet the default network.

Status: not yet published to npm.

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
  mainnet ~0.01 SBC/day), and `client` (the underlying `@x402/core` client).
- Config from the environment with radius-cli's variable names:
  `createRadiusFetch({ ...radiusEnv(process.env), signer })` reads `RADIUS_NETWORK`,
  `RADIUS_RPC_URL`, `RADIUS_FACILITATOR_URL`, `RADIUS_ASSET_ADDRESS` (alias `RADIUS_SBC_ADDRESS`), `RADIUS_PRIVATE_KEY`,
  `RADIUS_MAX_PER_REQUEST`; on Workers pass `c.env`.

## ERC-20 interactions

Metadata, allowance, `approve`, `transfer`, `transferFrom` and `Transfer` events as viem actions,
defaulting to SBC on Radius networks. Reads take any viem client; writes take a wallet client with
an account and wait for the receipt (Radius finality is sub-second). Amounts are `bigint` atomic
units or a display string such as `"1.5"`, parsed with the token's decimals.

```ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { radiusTestnet, erc20Actions, SBC } from 'radius-sdk';

const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: radiusTestnet.chain, transport: http() })
  .extend(erc20Actions());                                  // erc20Actions({ token }) to default another token

await wallet.getTokenMetadata();                             // { name: 'Stable Coin', symbol: 'SBC', decimals: 6, totalSupply }
await wallet.transfer({ to, amount: '1.50' });               // { hash, status: 'success', explorerUrl }
await wallet.approve({ spender, amount: 2_000_000n });       // atomic units; wait: false returns after sending
await wallet.getAllowance({ owner: wallet.account.address, spender });
await wallet.transferFrom({ from, to, amount: '0.10' });     // spend an allowance granted to this account
await wallet.getTransfers({ to, fromBlock });                // decoded Transfer logs
const unwatch = wallet.watchTransfers({ to, onTransfer: (t) => console.log(t.from, t.amount) });

// Or call the actions directly, viem style, on any client:
import { transfer, getAllowance } from 'radius-sdk';
await transfer(wallet, { token: '0x…', to, amount: '3' });   // a bare address: decimals() is read on-chain
```

`createRadiusFetch(...)` gains `allowance(spender)` and `approve(spender, amount)` for the payment
asset next to `send`.

## Permit2

Actions for the canonical [Permit2](https://github.com/Uniswap/permit2) contract (`PERMIT2_ADDRESS`,
the same on every Radius network), covering both of its flows. `permit2Actions()` is a client
extension; each action is also exported on its own.

```ts
import { permit2Actions } from 'radius-sdk';
const owner = createWalletClient({ account, chain: radiusTestnet.chain, transport: http() }).extend(permit2Actions());
const spender = createWalletClient({ account: spenderAccount, chain: radiusTestnet.chain, transport: http() }).extend(permit2Actions());

// Once per token: let Permit2 move the owner's SBC (unlimited by default, the x402 one-time approval).
await owner.getPermit2Approval({ owner: owner.account.address });     // ERC-20 allowance granted to Permit2
await owner.approvePermit2();                                          // approvePermit2({ amount: '5' }) to cap it

// SignatureTransfer (what x402 uses): one-off permit signed off-chain, submitted by the spender.
const signed = await owner.signPermit2Transfer({ amount: '0.01', spender: spender.account.address });
//   { permit: { permitted: { token, amount }, nonce, deadline }, spender, owner, signature, chainId }
await spender.permit2TransferFrom({ signed, to: spender.account.address });   // amount: pull less than permitted
await spender.isPermit2NonceUsed({ owner: signed.owner, nonce: signed.permit.nonce });   // true afterwards

// With a witness (extra data the signature is bound to, e.g. x402's `Witness(address to,uint256 validAfter)`):
const witness = { typeName: 'Witness', types: { Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }] }, value: { to, validAfter: 0n } };
const w = await owner.signPermit2Transfer({ amount: '0.01', spender: proxy, witness });
await spender.permit2TransferFrom({ signed: w, to });                  // calls permitWitnessTransferFrom with the hash + type string

// AllowanceTransfer (Uniswap-style): a signed allowance the spender can draw on until it expires.
const allowance = await owner.signPermit2Allowance({ amount: '5', spender: spender.account.address, expiration: now + 86_400 });
await spender.permit2Permit({ signed: allowance });                    // records it in Permit2
await spender.permit2AllowanceTransferFrom({ from: owner.account.address, to, amount: '1' });   // repeatable
await spender.getPermit2Allowance({ owner: owner.account.address, spender: spender.account.address });   // { amount, expiration, nonce }
```

Nonces: SignatureTransfer nonces are random 256-bit values (`randomPermit2Nonce()`, the default);
AllowanceTransfer nonces are sequential per (owner, token, spender) and read from Permit2 when
omitted. Deadlines default to 600 s, the same cap the x402 client applies. The EIP-712 domain,
type sets (`PERMIT_TRANSFER_FROM_TYPES`, `PERMIT_SINGLE_TYPES`), `permit2WitnessTypeString` and
`permit2WitnessHash` are exported for anyone assembling calls by hand; the witness type string is
derived with EIP-712's ordering rule and checked against the x402 layout in the tests.

## Balances: native RUSD vs stablecoins

Radius differs from other EVM chains here. `eth_getBalance` (viem's `getBalance`, MetaMask's
balance, `cast balance`) returns the account's native RUSD **plus** its convertible stablecoin
holdings (SBC) valued 1:1 and rescaled to 18 decimals: the total the account can spend, since
the Turnstile converts SBC into RUSD inline when a transaction needs it. Reading `eth_getBalance`
and an SBC `balanceOf` and adding them double-counts the SBC. The EVM itself is unchanged: the
`BALANCE` opcode (Solidity's `address.balance`) sees only the native amount.

The SDK reports each part on its own, as plain viem actions or as a client extension:

```ts
import { createPublicClient, http } from 'viem';
import { radiusTestnet, radiusActions, getBalances, getNativeBalance, getTokenBalance, SBC } from 'radius-sdk';

const client = createPublicClient({ chain: radiusTestnet.chain, transport: http() }).extend(radiusActions());

const b = await client.getBalances({ address });
b.native.raw            // 2345678000000000000n  — native RUSD only (wei)
b.native.aggregate      // 12345678000000000000n — what eth_getBalance / client.getBalance() returns
b.native.convertible    // 10000000000000000000n — aggregate − raw: SBC value the Turnstile can convert
b.tokens[0]             // { symbol: 'SBC', atomic: 10000000n, formatted: '10', decimals: 6, convertible: true, … }
b.totalFormatted        // '12.345678' — raw + every token at 1:1, 18 decimals

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
`convertible: true` only if the Turnstile counts them in `eth_getBalance` (today: SBC).

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
`faucetUrl` and `asset`; `chainId`, `network` (CAIP-2 `eip155:<id>`), `rpcUrl`, `explorerUrl`
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
| `src/` | `networks`, `balances`, `erc20`, `permit2`, `amounts`, `receipt`, `errors`; `hono/` (server); `client/` (buyer) |
| `examples/worker-seller` | Hono worker: free `/`, paid `/api/lookup` and `/api/query` (`pnpm dev`) |
| `examples/agent-buyer` | `buy.mjs` (pay a URL), `fresh-wallet.mjs` (gasless proof from a new wallet), `permit2-pull.mjs` (sign a Permit2 transfer off-chain, pull it from another account) |
| `examples/demo-dapp` | Test-dapp style page exercising both sides in the browser (burner wallet or MetaMask) |
| `test/` | unit tests (facilitator and RPC mocked; `client-parity.test.ts` pins the wire format against radius-cli's; `balances.test.ts` runs the native-balance init code in a real EVM); `test/e2e` real settlement and a live balance reconciliation on testnet or mainnet (`RADIUS_E2E=1 RADIUS_PRIVATE_KEY=… [RADIUS_NETWORK=mainnet] pnpm test:e2e`) |

Built on `@x402/core` (server and client), `@x402/evm` (client signing only) and viem.
