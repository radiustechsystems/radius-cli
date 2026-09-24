# Radius SDK demo dapp

One Cloudflare Worker that shows both sides of `radius-sdk`, in the spirit of the MetaMask test dapp:
a page of buttons, each exercising one thing, with the raw result next to it.

- **Seller side** (`src/worker.ts`): four priced endpoints behind one `radiusPayments()` middleware
  ($0.001 quote and lookup, $0.01 echo, a deliberately expensive $5 route), plus a free `/api/info`.
- **Buyer side** (`web/app.ts`, served as a static asset): a burner wallet kept in `localStorage`
  (or MetaMask), faucet drip, Permit2 approval, transfers, "fetch unpaid" to inspect the 402,
  "pay & fetch" with the decoded receipt, pay-any-URL, and on-chain reconciliation of a tx hash.
  The client settings card lets you change the per-request ceiling, decline offers, veto approvals,
  or forbid approvals, to see each failure mode.

## Run locally

```bash
# from the repo root
pnpm install && pnpm --filter radius-sdk build
pnpm --filter radius-demo-dapp dev   # builds web/app.ts → public/app.js, then wrangler dev
```

Open http://localhost:8787. Defaults: testnet, payments go to `PAY_TO` in `wrangler.toml`
(override in `.dev.vars`). First click **Faucet drip** to give the burner ~0.5 SBC, then
**Pay & fetch** on any route.

The server's network is fixed by `RADIUS_NETWORK` in `wrangler.toml`; the page follows it. To try
mainnet, change both the var and fund the burner yourself (mainnet faucet is 0.01 SBC per day).

## What to look at

- The 402: `paymentRequired.accepts[0]` is the whole price contract (asset, amount, payTo, Permit2,
  permit domain) and `extensions.eip2612GasSponsoring` is why a fresh wallet pays without an
  approval transaction.
- The receipt after a paid fetch: `transaction`, `payer`, `amount`, `explorerUrl`.
- The log: every `onPaymentRequired`, `onApprovalRequired`, and `onPaid` callback.
- `/api/premium` with the default $0.01 ceiling: refused client-side before anything is signed.

Note: the Radius faucet API has no CORS headers, so the worker proxies it at `/faucet/*` and the
page passes `faucetUrl: <origin>/faucet` to the SDK. Node scripts can call the faucet directly.
