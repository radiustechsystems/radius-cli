/**
 * MPP end-to-end against the real Radius facilitator, in all three pairings: radius-sdk buyer and
 * seller, mppx buyer → radius-sdk seller, radius-sdk buyer → mppx seller. Same env as
 * settlement.test.ts; each payment moves 0.001 SBC from RADIUS_PRIVATE_KEY's wallet to PAY_TO
 * (default: itself). Catches drift in what mppx sends or accepts, and in the facilitator.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { Receipt } from 'mppx';
import { Mppx as MppxClient, evm as evmClient } from 'mppx/client';
import { Mppx as MppxServer, evm as evmServer } from 'mppx/server';
import { radiusPayments } from '../../src/server/index.js';
import { createRadiusFetch, type PaymentReceipt } from '../../src/client/index.js';
import { resolveNetwork } from '../../src/networks.js';

const NET = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const network = resolveNetwork(NET);
const KEY = process.env.RADIUS_PRIVATE_KEY as `0x${string}` | undefined;
const run = process.env.RADIUS_E2E && KEY ? describe : describe.skip;
const SECRET = 'e2e-mpp-secret-not-for-production-0123456789';
const TX = /^0x[0-9a-f]{64}$/;

run(`${NET} e2e: MPP`, () => {
  const payer = privateKeyToAccount(KEY!);
  const PAY_TO = (process.env.PAY_TO as `0x${string}`) ?? payer.address;
  const { asset } = network;

  const settled: PaymentReceipt[] = [];
  const pay = radiusPayments({ network: NET, payTo: PAY_TO, routes: { 'GET /api/lookup': '$0.001' }, mpp: { secretKey: SECRET }, onSettled: (r) => void settled.push(r) });
  const app = pay.wrap((_request, payment) => Response.json({ payment }));
  const sdkSeller: typeof fetch = (input, init) => app(new Request(input, init));
  const sdkBuyer = (fetch: typeof globalThis.fetch) => createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01', protocols: ['mpp'], fetch });

  beforeAll(async () => {
    const { atomic } = await createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01' }).balance();
    expect(atomic, `payer needs at least 0.003 ${asset.symbol} on ${NET}`).toBeGreaterThanOrEqual(3000n);
  });

  it('radius-sdk buyer → radius-sdk seller', async () => {
    const res = await sdkBuyer(sdkSeller)('http://seller.test/api/lookup');
    expect(res.status).toBe(200);
    const { payment } = (await res.json()) as { payment: PaymentReceipt };
    expect(payment).toMatchObject({ success: true, protocol: 'mpp', network: network.network });
    expect(payment.transaction).toMatch(TX);
    expect(Receipt.fromResponse(res).reference).toBe(payment.transaction);
    expect(settled.at(-1)?.transaction).toBe(payment.transaction);
  }, 60_000);

  it('mppx buyer → radius-sdk seller', async () => {
    const mppx = MppxClient.create({
      polyfill: false,
      fetch: sdkSeller,
      methods: [evmClient.charge({ account: payer, authorization: { name: asset.name, version: asset.version }, decimals: asset.decimals, maxAmount: '0.01', networks: [network.chainId] })],
      orderChallenges: (candidates: { challenge: { id: string } }[]) => candidates.filter((c) => !String(c.challenge.id).startsWith('x402:')),
    } as never);
    const res = await mppx.fetch('http://seller.test/api/lookup');
    expect(res.status).toBe(200);
    expect(Receipt.fromResponse(res).reference).toMatch(TX);
  }, 60_000);

  it('radius-sdk buyer → mppx seller', async () => {
    const mppx = MppxServer.create({
      secretKey: SECRET,
      realm: 'seller.test',
      methods: [
        evmServer.charge({
          currency: asset.address,
          chainId: network.chainId,
          decimals: asset.decimals,
          authorization: { name: asset.name, version: asset.version },
          recipient: PAY_TO,
          x402: { facilitator: network.facilitatorUrl! },
        }),
      ],
    });
    const mppxSeller: typeof fetch = async (input, init) => {
      const result = await mppx.charge({ amount: '0.001' })(new Request(input, init));
      return result.status === 402 ? result.challenge : result.withReceipt(Response.json({ ok: true }));
    };
    let paid: PaymentReceipt | undefined;
    const res = await createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01', protocols: ['mpp'], fetch: mppxSeller, onPaid: (r) => void (paid = r) })(
      'http://seller.test/api/lookup',
    );
    expect(res.status).toBe(200);
    expect(paid).toMatchObject({ protocol: 'mpp', network: network.network });
    expect(paid?.transaction).toMatch(TX);
  }, 60_000);
});
