/**
 * End-to-end for the web-standard handler against the real Radius facilitator: the
 * seller is `radiusPayments()` from `radius-sdk/server` called directly with a
 * `Request`, the buyer is `createRadiusFetch`. Same env as settlement.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { radiusPayments } from '../../src/server/index.js';
import { createRadiusFetch } from '../../src/client/index.js';
import { getPaymentReceipt } from '../../src/receipt.js';
import { resolveNetwork } from '../../src/networks.js';

const NET = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const network = resolveNetwork(NET);
const KEY = process.env.RADIUS_PRIVATE_KEY as `0x${string}` | undefined;
const run = process.env.RADIUS_E2E && KEY ? describe : describe.skip;

run(`${NET} e2e (web-standard handler)`, () => {
  const payer = privateKeyToAccount(KEY!);
  const PAY_TO = (process.env.PAY_TO as `0x${string}`) ?? payer.address;
  const settled: { tx?: string; path: string }[] = [];
  const pay = radiusPayments({
    network: NET,
    payTo: PAY_TO,
    routes: { 'GET /api/lookup': '$0.001' },
    onSettled: (r, request) => { settled.push({ tx: r.transaction, path: new URL(request.url).pathname }); },
  });
  const app = pay.wrap((_request, payment) => Response.json({ ok: true, payer: payment?.payer, tx: payment?.transaction }));
  const serverFetch: typeof fetch = (input, init) => app(new Request(input, init));
  const buyer = createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01', fetch: serverFetch });

  beforeAll(async () => {
    const { atomic } = await buyer.balance();
    expect(atomic, `payer needs at least 0.001 SBC on ${NET}`).toBeGreaterThanOrEqual(1000n);
  });

  it('pays a lookup with real settlement; the handler and onSettled both see the receipt', async () => {
    const res = await buyer('http://seller.test/api/lookup');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; payer: string; tx: string };
    expect(body.ok).toBe(true);
    expect(body.payer).toBe(payer.address);
    expect(body.tx).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = getPaymentReceipt(res, buyer.network)!;
    expect(receipt).toMatchObject({ success: true, transaction: body.tx, network: network.network });
    expect(settled).toEqual([{ tx: body.tx, path: '/api/lookup' }]);
  }, 60_000);
});
