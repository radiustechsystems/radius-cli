import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createFaucetClient, FaucetError } from 'radius-sdk/faucet';
import {
  faucetExitCode,
  formatDrip,
  formatStatus,
  makeFaucetClient,
  parseSignatureMode,
  runDrip,
  runStatus,
} from '../src/commands/walletFaucet.js';

const ADDRESS = '0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f';
const TX = `0x${'ab'.repeat(32)}` as const;

type Route = (init: RequestInit | undefined, url: URL) => Response;

/** A fake faucet: routes keyed by `METHOD /path`; records every request body. */
function fakeFaucet(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), { status: 404 });
    return route(init, url);
  }) as typeof globalThis.fetch;
  const client = createFaucetClient({ network: 'testnet', url: 'https://faucet.test/api/v1/faucet', fetch });
  return { client, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('wallet faucet drip', () => {
  it('drips unsigned and shapes the output for --json and text', async () => {
    const { client, calls } = fakeFaucet({
      'POST /api/v1/faucet/drip': () => json({ success: true, address: ADDRESS, token: 'SBC', amount: '0.5', tx_hash: TX, native: { token: 'RUSD', amount: '0.001' }, next_drip_at: 1_700_000_000 }),
    });
    const out = await runDrip(client, ADDRESS, undefined, 'auto');
    expect(out).toEqual({
      faucetUrl: 'https://faucet.test/api/v1/faucet',
      address: ADDRESS,
      token: 'SBC',
      amount: '0.5',
      txHash: TX,
      explorerUrl: `https://testnet.radiustech.xyz/tx/${TX}`,
      native: { token: 'RUSD', amount: '0.001', txHash: null },
      nextDripAt: '2023-11-14T22:13:20.000Z',
    });
    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/faucet/drip', body: { address: ADDRESS, token: 'SBC' } }]);
    expect(formatDrip(out)).toEqual([
      'Faucet:    https://faucet.test/api/v1/faucet',
      `Address:   ${ADDRESS}`,
      'Dripped:   0.5 SBC',
      `Tx:        https://testnet.radiustech.xyz/tx/${TX}`,
      'Gas:       0.001 RUSD',
      'Next drip: 2023-11-14T22:13:20.000Z',
    ]);
  });

  it('signs the challenge with the local account only when the faucet asks', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const challenge = `Radius faucet: ${account.address} nonce 42`;
    const { client, calls } = fakeFaucet({
      'POST /api/v1/faucet/drip': (init) => {
        const body = JSON.parse(init?.body as string) as { signature?: string };
        if (!body.signature) return json({ error: { code: 'signature_required', message: 'sign', details: { challenge } } }, 401);
        return json({ success: true, address: account.address, token: 'SBC', amount: '0.01', tx_hash: TX });
      },
    });
    const out = await runDrip(client, account.address, account, 'auto');
    expect(out.amount).toBe('0.01');
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/faucet/drip', '/api/v1/faucet/drip']);
    const signature = (calls[1].body as { signature: `0x${string}` }).signature;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await account.signMessage({ message: challenge })).toBe(signature);
  });

  it('cannot drip into another address when the faucet requires a signature', async () => {
    const { client } = fakeFaucet({
      'POST /api/v1/faucet/drip': () => json({ error: { code: 'signature_required', message: 'sign' } }, 401),
    });
    const err = await runDrip(client, ADDRESS, undefined, 'auto').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect((err as FaucetError).faucetCode).toBe('signer_required');
    expect(faucetExitCode(err as FaucetError)).toBe(2);
  });

  it('surfaces rate limits with the retry hint and exit code 2', async () => {
    const { client } = fakeFaucet({
      'POST /api/v1/faucet/drip': () => json({ error: { code: 'rate_limited', message: 'slow down', retry_after_ms: 42_000 } }, 429),
    });
    const err = await runDrip(client, ADDRESS, undefined, 'never').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect((err as FaucetError).retryAfterMs).toBe(42_000);
    expect((err as FaucetError).message).toMatch(/retry in 42 s/);
    expect(faucetExitCode(err as FaucetError)).toBe(2);
    expect(faucetExitCode(new FaucetError('internal_error', 'boom'))).toBe(1);
  });
});

describe('wallet faucet status', () => {
  it('shapes a ready status', async () => {
    const { client } = fakeFaucet({
      [`GET /api/v1/faucet/status/${ADDRESS}`]: () => json({ address: ADDRESS.toLowerCase(), token: 'SBC', rate_limited: false, remaining_requests: 3, drip_amount: '0.5', native_drip_amount: '0.001' }),
    });
    const out = await runStatus(client, ADDRESS);
    expect(out).toEqual({
      faucetUrl: 'https://faucet.test/api/v1/faucet',
      address: ADDRESS.toLowerCase(),
      token: 'SBC',
      rateLimited: false,
      retryAfterMs: null,
      remainingRequests: 3,
      dripAmount: '0.5',
      nativeDripAmount: '0.001',
      unlimited: false,
    });
    expect(formatStatus(out).at(-2)).toBe('Drip:      0.5 SBC + 0.001 RUSD for gas');
    expect(formatStatus(out).at(-1)).toBe('Status:    ready, 3 requests left');
  });

  it('shapes rate-limited and unlimited statuses', async () => {
    const { client } = fakeFaucet({
      [`GET /api/v1/faucet/status/${ADDRESS}`]: () => json({ rate_limited: true, retry_after_ms: 5_400_000, remaining_requests: 0, drip_amount: '0.5' }),
    });
    const limited = await runStatus(client, ADDRESS);
    expect(limited.rateLimited).toBe(true);
    expect(formatStatus(limited).at(-1)).toBe('Status:    rate limited, retry in 90 min');

    const { client: unlimitedClient } = fakeFaucet({
      [`GET /api/v1/faucet/status/${ADDRESS}`]: () => json({ rate_limited: false, remaining_requests: null, unlimited: true, drip_amount: 0.5 }),
    });
    const unlimited = await runStatus(unlimitedClient, ADDRESS);
    expect(unlimited).toMatchObject({ unlimited: true, remainingRequests: null, dripAmount: '0.5' });
    expect(formatStatus(unlimited).at(-1)).toBe('Status:    ready (no rate limit)');
  });
});

describe('faucet options', () => {
  it('resolves the faucet URL from the flag, then config, then the network', () => {
    expect(makeFaucetClient({ network: 'testnet' }, {}).url).toBe('https://testnet.radiustech.xyz/api/v1/faucet');
    expect(makeFaucetClient({ network: 'mainnet' }, {}).url).toBe('https://network.radiustech.xyz/api/v1/faucet');
    expect(makeFaucetClient({ network: 'testnet', faucetUrl: 'https://proxy.example/faucet/' }, {}).url).toBe('https://proxy.example/faucet');
    expect(makeFaucetClient({ network: 'testnet', faucetUrl: 'https://proxy.example/faucet' }, { faucetUrl: 'http://localhost:8787/faucet' }).url).toBe('http://localhost:8787/faucet');
    expect(makeFaucetClient({ network: 'testnet' }, { token: 'USDX' }).token).toBe('USDX');
  });

  it('validates --signature', () => {
    expect(parseSignatureMode(undefined)).toBe('auto');
    expect(parseSignatureMode('always')).toBe('always');
    expect(() => parseSignatureMode('maybe')).toThrow(/auto, always, never/);
  });
});
