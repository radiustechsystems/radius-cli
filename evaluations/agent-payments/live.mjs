#!/usr/bin/env node
/** Opt-in, bounded real testnet proof for a 0.001 SBC resource price. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRadiusFetch, getPaymentReceipt } from '../../packages/sdk/dist/client/index.js';
import { radiusPayments } from '../../packages/sdk/dist/server/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromSdk = createRequire(join(ROOT, 'packages/sdk/package.json'));
const { isAddress } = requireFromSdk('viem');
const OUTPUT = resolve(process.env.RADIUS_EVAL_OUTPUT ?? join(ROOT, 'evaluations/agent-payments/results/live.json'));
const PRICE = 1000n;
const settled = [];
const partial = { suite: 'agent-payments-live', scenarioVersion: 1, generatedAt: new Date().toISOString(),
  network: 'eip155:72344', scenarioId: 'NET-01', passed: false, verifiedNetworkSettlement: false, stage: 'preflight' };

async function main() {
  if (!process.argv.includes('--confirm-testnet-spend') || process.env.RADIUS_EVAL_LIVE !== '1') {
    throw new Error('Live evaluation requires RADIUS_EVAL_LIVE=1 and --confirm-testnet-spend; it pays a 0.001 SBC testnet resource price plus possible network fees.');
  }
  const key = process.env.RADIUS_EVAL_PRIVATE_KEY;
  const payTo = process.env.RADIUS_EVAL_PAY_TO;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('Set RADIUS_EVAL_PRIVATE_KEY to a funded testnet-only key.');
  if (!isAddress(payTo ?? '')) throw new Error('Set RADIUS_EVAL_PAY_TO to a separate testnet seller address.');

  const seller = radiusPayments({
    network: 'testnet', payTo, routes: { 'GET /api/eval-lookup': { price: { amount: PRICE.toString() }, description: 'One evaluation lookup' } },
    onSettled: (receipt) => settled.push(receipt),
  });
  const app = seller.wrap((_request, payment) => Response.json({ result: 'lookup complete', transaction: payment?.transaction }));
  const buyer = createRadiusFetch({
    network: 'testnet', signer: key, maxPerRequest: { amount: PRICE.toString() }, permit2Approval: 'never',
    onPaymentRequired: (offer) => offer.network === 'eip155:72344' && offer.payTo.toLowerCase() === payTo.toLowerCase() && offer.amount === PRICE.toString(),
    fetch: (input, init) => app(new Request(input, init)),
  });
  if (buyer.address.toLowerCase() === payTo.toLowerCase()) throw new Error('Buyer and seller must be distinct wallets.');
  Object.assign(partial, { buyer: buyer.address, seller: payTo, atomicAmount: PRICE.toString(), stage: 'balance-check' });
  const balance = await buyer.balance();
  if (balance.atomic < PRICE) throw new Error('Buyer needs at least 0.001 SBC. This runner will not create an unsponsored Permit2 approval.');

  const response = await buyer('http://seller.eval.local/api/eval-lookup');
  const receipt = getPaymentReceipt(response, buyer.network);
  Object.assign(partial, { stage: 'response-received', httpStatus: response.status,
    sellerReceipt: receipt && { success: receipt.success, transaction: receipt.transaction, network: receipt.network } });
  if (receipt?.transaction) process.stderr.write(`Live evaluation transaction: ${receipt.transaction}\n`);
  const delivery = await response.json();
  assert.equal(response.status, 200, 'paid resource must be delivered');
  assert.equal(delivery.result, 'lookup complete');
  assert.equal(receipt?.success, true, 'seller must report successful settlement');
  assert.match(receipt.transaction ?? '', /^0x[0-9a-fA-F]{64}$/);
  assert.equal(receipt.network, 'eip155:72344');
  assert.equal(delivery.transaction, receipt.transaction);
  assert.equal(settled.length, 1, 'seller callback must record one settlement');

  const chain = await buyer.getSettlement(receipt.transaction);
  partial.stage = 'chain-reconciled';
  assert.equal(chain?.status, 'success', 'chain transaction must have succeeded');
  const transfers = chain.transfers.filter((t) =>
    t.from.toLowerCase() === buyer.address.toLowerCase() && t.to.toLowerCase() === payTo.toLowerCase());
  assert.equal(transfers.reduce((sum, t) => sum + t.amount, 0n), PRICE, 'chain transfer must match buyer, seller and amount');

  const report = {
    suite: 'agent-payments-live', scenarioVersion: 1, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dirtyCheckout: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
    generatedAt: new Date().toISOString(), network: 'eip155:72344',
    scenarioId: 'NET-01', passed: true, buyer: buyer.address, seller: payTo, atomicAmount: PRICE.toString(),
    httpStatus: response.status, delivered: true, sellerReceipt: { success: receipt.success, transaction: receipt.transaction, network: receipt.network },
    chain: { status: chain.status, transaction: chain.transaction, blockNumber: chain.blockNumber.toString(),
      matchedTransferAmount: PRICE.toString() },
    verifiedNetworkSettlement: true,
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`PASS NET-01: delivered 0.001 SBC lookup; transaction ${receipt.transaction}\nReport: ${OUTPUT}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (settled[0]?.transaction) {
    partial.sellerCallbackTransaction = settled[0].transaction;
    process.stderr.write(`Seller callback transaction for reconciliation: ${settled[0].transaction}\n`);
  }
  try {
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify({ ...partial, error: error.message })}\n`);
    process.stderr.write(`Partial report: ${OUTPUT}\n`);
  } catch (writeError) { process.stderr.write(`Could not write partial report: ${writeError}\n`); }
  process.exitCode = 1;
});
