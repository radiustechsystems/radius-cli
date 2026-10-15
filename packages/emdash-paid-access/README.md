# radius-emdash-paid-access

Charge AI agents per request, in stablecoin over [x402](https://x402.org) on Radius, for an [EmDash](https://emdashcms.com) or Astro site. Readers who send no payment header get a `402 Payment Required` with machine-readable instructions; a request that pays is settled on Radius and served.

It is an Astro integration, like `@emdash-cms/x402`, because EmDash's sandboxed plugins cannot intercept page responses. It works on any server-rendered Astro site, with or without EmDash, and it runs on `radius-sdk/server`.

> **Status:** 0.1.0, built against `radius-sdk` 0.5. Settlement runs through the Radius facilitator. Radius mainnet settles in SBC; Radius testnet settles in testnet SBC. This package has been exercised against the testnet facilitator for the 402 challenge only; run a paid request end to end on testnet before pointing it at real traffic.

## Install

```bash
pnpm add radius-emdash-paid-access
```

Your site needs `output: 'server'` (or server-rendered routes) and an adapter.

## Charge by path

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import radiusPaidAccess from 'radius-emdash-paid-access';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    radiusPaidAccess({
      payTo: '0xYourWalletAddress',
      network: 'testnet', // 'mainnet' for real money
      defaultPrice: '$0.01',
      routes: { '/posts/*': '$0.05', '/archive/*': null }, // null uses defaultPrice
    }),
  ],
});
```

Matching `GET` requests are charged before the page renders. Everything else is untouched.

## Price each page yourself

Leave `routes` empty and call `enforce()` in a page, for example to read the price from an EmDash field:

```astro
---
import { getEmDashEntry } from 'emdash';

const { entry } = await getEmDashEntry('posts', Astro.params.slug);
if (!entry) return Astro.rewrite('/404');

const { radiusPaidAccess } = Astro.locals;
const result = await radiusPaidAccess.enforce(Astro.request, { price: entry.data.price ?? '$0.01' });
if (result instanceof Response) return result; // 402: send payment instructions

radiusPaidAccess.applyHeaders(result, Astro.response); // settlement receipt for the payer
---
<article>{entry.data.title}</article>
```

Add the type for `Astro.locals.radiusPaidAccess` in `src/env.d.ts`:

```ts
/// <reference types="radius-emdash-paid-access/locals" />
```

Look the content up before calling `enforce()`. Payment settles before the page renders, so an unknown slug should be a free 404, not a charged one.

## Options

| Option | Default | |
| --- | --- | --- |
| `payTo` | required | Wallet that receives payments |
| `network` | `'mainnet'` | `'mainnet'` or `'testnet'` (Radius), or `'base'` / `'base-sepolia'` with a facilitator when using `createPaidAccess` |
| `defaultPrice` | `'$0.01'` | USD string, number, or `{ amount }` in atomic units |
| `description` | none | Shown in the 402 |
| `routes` | none | Path patterns to charge automatically; `{ pattern: price \| null }` or a list of patterns |
| `botOnly` | `false` | Charge only requests Cloudflare Bot Management scores below `botScoreThreshold` |
| `botScoreThreshold` | `30` | Scores under this are bots |

`botOnly` fails open: with no score (local dev, a non-Cloudflare host, Bot Management off) a request counts as human and passes free. Do not rely on it where a missing score must not mean free access.

`radiusPaidAccess()` takes options that survive serialisation into the middleware. For a custom facilitator, extra networks, MPP, or an `onSettled` hook, call `createPaidAccess()` yourself from `radius-emdash-paid-access` in a page or your own middleware; it accepts the same options as `radiusPayments()` in `radius-sdk/server`.

## Limits

- Only `GET` is charged. `HEAD` and other methods pass free.
- It charges every matching request that carries no payment. It does not tell agents from people unless you use `botOnly` or your own check before calling `enforce()`, and a header check alone can be spoofed.
- The default `settle: 'before'` moves funds before the page renders. A page that then fails still keeps the payment; reconcile with `onSettled`.
- Shared caches can serve a paid page to someone who has not paid. Paid responses carry `Cache-Control: private`; keep paid paths out of a CDN's public cache.

## Develop

```bash
pnpm --filter radius-emdash-paid-access test
```
