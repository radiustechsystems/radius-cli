/**
 * Unsponsored path on testnet: a fresh wallet holding only SBC pays a server whose 402
 * does NOT declare gas sponsoring, so the SDK sends the one-time Permit2 approval itself.
 * Also exercises send(), getSettlement(), fund(), and permit2Approval: 'never'.
 *
 *   RADIUS_E2E=1 RADIUS_PRIVATE_KEY=0x… npx vitest run test/e2e/approval
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { maxUint256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { radiusPayments } from '../../src/hono/index.js';
import { createRadiusFetch } from '../../src/client/index.js';
import { getPaymentReceipt } from '../../src/receipt.js';

const KEY = process.env.RADIUS_PRIVATE_KEY as `0x${string}` | undefined;
const NET = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const run = process.env.RADIUS_E2E && KEY ? describe : describe.skip;
// Fresh-wallet float: 0.001 for the payments plus >=0.01 so Turnstile can convert SBC into gas for the approval tx.
const FLOAT = NET === 'mainnet' ? '$0.012' : '$0.03';
const FLOAT_ATOMIC = NET === 'mainnet' ? 12000n : 30000n;

run(`${NET} e2e: unsponsored Permit2 approval`, () => {
  const funder = createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01' });
  const PAY_TO = funder.address;
  const freshKey = generatePrivateKey();
  const fresh = privateKeyToAccount(freshKey);

  const app = new Hono();
  app.use(radiusPayments({ network: NET, payTo: PAY_TO, gasSponsoring: false, routes: { 'GET /api/lookup': '$0.001' } }));
  app.get('/api/lookup', (c) => c.json({ ok: true }));
  const serverFetch: typeof fetch = (input, init) => app.fetch(new Request(input, init));

  it('send() funds the fresh wallet and getSettlement() sees the transfer', async () => {
    const tx = await funder.send(fresh.address, FLOAT);
    expect(tx.status).toBe('success');
    const s = (await funder.getSettlement(tx.hash))!;
    expect(s.status).toBe('success');
    expect(s.paid(fresh.address)).toBe(FLOAT_ATOMIC);
    expect(s.paidFormatted(fresh.address)).toBe(`${FLOAT.slice(1)} SBC`);
  }, 60_000);

  it("permit2Approval: 'never' refuses instead of sending a transaction", async () => {
    const strict = createRadiusFetch({ network: NET, signer: freshKey, maxPerRequest: '$0.01', fetch: serverFetch, permit2Approval: 'never' });
    expect(await strict.permit2Allowance()).toBe(0n);
    await expect(strict('http://seller.test/api/lookup')).rejects.toMatchObject({ code: 'approval_required' });
    expect(await strict.permit2Allowance()).toBe(0n);
  }, 60_000);

  it('auto mode sends one unlimited approval, then pays with real settlement', async () => {
    const approvals: unknown[] = [];
    const buyer = createRadiusFetch({ network: NET, signer: freshKey, maxPerRequest: '$0.01', fetch: serverFetch, onApprovalRequired: (r) => { approvals.push(r); return true; } });
    const res = await buyer('http://seller.test/api/lookup');
    expect(res.status).toBe(200);
    expect(approvals).toHaveLength(1);
    expect(await buyer.permit2Allowance()).toBe(maxUint256);
    const receipt = getPaymentReceipt(res, buyer.network)!;
    expect(receipt.success).toBe(true);
    const settlement = (await buyer.getSettlement(receipt.transaction as `0x${string}`))!;
    expect(settlement.paid(PAY_TO)).toBe(1000n);
    // Second payment needs no further approval.
    const res2 = await buyer('http://seller.test/api/lookup');
    expect(res2.status).toBe(200);
    expect(approvals).toHaveLength(1);
  }, 120_000);

  // Mainnet drips are 1/day and 0.01 SBC; don't burn one on a throwaway wallet.
  it.skipIf(NET === 'mainnet')('fund() drips from the faucet', async () => {
    const buyer = createRadiusFetch({ network: NET, signer: freshKey, maxPerRequest: '$0.01' });
    const status = await buyer.faucet!.status(buyer.address);
    expect(status.token).toBe('SBC');
    expect(status.rateLimited).toBe(false);
    const before = (await buyer.balance()).atomic;
    const drip = await buyer.fund();
    expect(drip.success).toBe(true);
    expect(drip.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    if (status.dripAmount) expect(drip.amount).toBe(status.dripAmount);
    const after = (await buyer.balance()).atomic;
    expect(after).toBeGreaterThan(before);
  }, 60_000);
});
