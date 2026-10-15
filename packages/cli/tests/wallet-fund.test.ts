import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { verifyMessage, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerWallet } from '../src/commands/wallet.js';

// `wallet fund` against a stubbed faucet: the challenge is fetched, signed with the wallet key and
// posted to /drip. No request leaves the process.

const FAUCET = 'https://testnet.radiustech.xyz/api/v1/faucet';
const CHALLENGE = 'Radius faucet challenge 123';
const TX = `0x${'ab'.repeat(32)}` as Hex;

async function run(...args: string[]): Promise<string> {
  const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--private-key <hex>').option('--sbc <address>').option('--rusd <address>').option('--json');
  registerWallet(program);
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
  try {
    await program.parseAsync(['node', 'radius-cli', ...args]);
  } finally {
    log.mockRestore();
  }
  return out;
}

function stubFaucet(drip: { status: number; body: unknown }): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/challenge/')) return Response.json({ message: CHALLENGE });
    if (url.endsWith('/drip')) return Response.json(drip.body, { status: drip.status });
    throw new Error(`unexpected request ${url}`);
  });
  return calls;
}

describe('wallet fund', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuses mainnet without contacting the faucet', async () => {
    const calls = stubFaucet({ status: 200, body: {} });
    await expect(run('--network', 'mainnet', '--private-key', generatePrivateKey(), 'wallet', 'fund')).rejects.toThrow(/testnet SBC only/);
    expect(calls).toHaveLength(0);
  });

  it('signs the faucet challenge with the wallet key and reports the drip', async () => {
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);
    const calls = stubFaucet({ status: 200, body: { success: true, amount: '0.5', tx_hash: TX } });

    const out = JSON.parse(await run('--network', 'testnet', '--private-key', key, '--json', 'wallet', 'fund'));

    expect(calls.map((c) => c.url)).toEqual([`${FAUCET}/challenge/${address}?token=SBC`, `${FAUCET}/drip`]);
    const body = JSON.parse(String(calls[1].init?.body)) as { address: string; token: string; signature: Hex };
    expect(body).toMatchObject({ address, token: 'SBC' });
    expect(await verifyMessage({ address, message: CHALLENGE, signature: body.signature })).toBe(true);
    expect(out).toEqual({
      address,
      network: 'eip155:72344',
      token: 'SBC',
      amount: '0.5',
      txHash: TX,
      explorerUrl: `https://testnet.radiustech.xyz/tx/${TX}`,
    });
  });

  it('uses --faucet-url', async () => {
    const calls = stubFaucet({ status: 200, body: { success: true, amount: '0.5', tx_hash: TX } });
    await run('--network', 'testnet', '--private-key', generatePrivateKey(), 'wallet', 'fund', '--faucet-url', 'https://faucet.example/api/');
    expect(calls[1].url).toBe('https://faucet.example/api/drip');
  });

  it('surfaces the faucet error code and retry hint', async () => {
    stubFaucet({ status: 429, body: { success: false, error: { code: 'RATE_LIMITED', message: 'slow down', retry_after_ms: 42_000 } } });
    await expect(run('--network', 'testnet', '--private-key', generatePrivateKey(), 'wallet', 'fund')).rejects.toThrow(
      'Faucet drip failed: RATE_LIMITED slow down (retry in 42s)',
    );
  });
});
