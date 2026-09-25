/**
 * ERC-20 actions against a live Radius node: transfer, approve, transferFrom, a revert with an
 * explicit gas limit, `wait: false`, and the Transfer query/watcher. Testnet only: it spends
 * about 0.03 SBC plus gas from RADIUS_PRIVATE_KEY, and the mainnet faucet drips too little to
 * replace that.
 *
 *   RADIUS_E2E=1 RADIUS_PRIVATE_KEY=0x… npx vitest run test/e2e/erc20
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { getTokenBalance } from '../../src/balances.js';
import { erc20Actions, getTransfers, watchTransfers, type TokenTransfer } from '../../src/erc20.js';
import { resolveNetwork, SBC } from '../../src/networks.js';

const KEY = process.env.RADIUS_PRIVATE_KEY as `0x${string}` | undefined;
const NET = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const run = process.env.RADIUS_E2E && KEY && NET !== 'mainnet' ? describe : describe.skip;
const TIMEOUT = 60_000;

run(`${NET} e2e: ERC-20 actions`, () => {
  const network = resolveNetwork(NET);
  const chain = network.chain;
  const funderAccount = privateKeyToAccount(KEY!);
  const fresh = privateKeyToAccount(generatePrivateKey());
  const pub = createPublicClient({ chain, transport: http() });
  const funder = createWalletClient({ account: funderAccount, chain, transport: http() }).extend(erc20Actions({ network }));
  const wallet = createWalletClient({ account: fresh, chain, transport: http() }).extend(erc20Actions({ network }));
  const balance = async (address: `0x${string}`) => (await getTokenBalance(pub, { address, token: SBC })).atomic;
  let startHead = 0n;
  let fundingHash: `0x${string}`;

  it('transfer funds a fresh wallet', async () => {
    startHead = await pub.getBlockNumber();
    const r = await funder.transfer({ to: fresh.address, amount: '0.03' });
    expect(r.status).toBe('success');
    fundingHash = r.hash;
    expect(await balance(fresh.address)).toBe(30_000n);
  }, TIMEOUT);

  it('approve sets the allowance and transferFrom spends it', async () => {
    expect((await funder.approve({ spender: fresh.address, amount: '0.005' })).status).toBe('success');
    expect(await funder.getAllowance({ owner: funderAccount.address, spender: fresh.address })).toBe(5_000n);
    const funderBefore = await balance(funderAccount.address);
    // The fresh wallet pays this transaction's gas (in SBC via Turnstile); the funder moves exactly 0.005.
    expect((await wallet.transferFrom({ from: funderAccount.address, to: fresh.address, amount: '0.005' })).status).toBe('success');
    expect(await funder.getAllowance({ owner: funderAccount.address, spender: fresh.address })).toBe(0n);
    expect(await balance(funderAccount.address)).toBe(funderBefore - 5_000n);
  }, TIMEOUT);

  it('wait: false is pending until the receipt says otherwise', async () => {
    const r = await wallet.transfer({ to: funderAccount.address, amount: '0.001', wait: false });
    expect(r.status).toBe('pending');
    expect((await pub.waitForTransactionReceipt({ hash: r.hash })).status).toBe('success');
  }, TIMEOUT);

  it('a transfer above the balance with an explicit gas limit reverts on-chain', async () => {
    const before = await balance(fresh.address);
    const r = await wallet.transfer({ to: funderAccount.address, amount: '1000', gas: 120_000n });
    expect(r.status).toBe('reverted');
    expect(await balance(fresh.address)).toBeLessThanOrEqual(before); // only gas was spent
  }, TIMEOUT);

  it('getTransfers and watchTransfers replay the funding transfer', async () => {
    const past = await getTransfers(pub, { token: SBC, to: fresh.address, fromBlock: startHead });
    expect(past.map((t) => t.transactionHash)).toContain(fundingHash);
    const seen: TokenTransfer[] = [];
    const unwatch = watchTransfers(pub, { token: SBC, to: fresh.address, fromBlock: startHead, onTransfer: (t) => { seen.push(t); }, pollingInterval: 500 });
    try {
      await vi.waitFor(() => expect(seen.map((t) => t.transactionHash)).toContain(fundingHash), { timeout: 30_000 });
    } finally {
      unwatch();
    }
  }, TIMEOUT);
});
