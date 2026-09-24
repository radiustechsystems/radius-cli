/**
 * Swap client against a mock of the swap API: instructions, prepare (EIP-712 SwapIntent verified
 * the way the server does), broadcast, status, session listing, polling and the error envelope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTransaction, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSwapClient, SwapError, swapIntentTypedData, swapSessionListAccessTypedData, toSignableTransaction, type SwapStatus, type SwapFlowStatus } from '../src/swap.js';
import { createRadiusFetch } from '../src/client/index.js';
import { RadiusPaymentError, radiusEnv, radiusTestnet, resolveNetwork } from '../src/index.js';

const PK = ('0x' + '11'.repeat(32)) as Hex;
const ACCOUNT = privateKeyToAccount(PK);
const ADDR = ACCOUNT.address;
const DEST = '0x2222222222222222222222222222222222222222' as const;
const URL_ = 'https://swap.test/api/v1/swap';
const DEPOSIT = '0x3333333333333333333333333333333333333333' as const;
const BASE_SEPOLIA_SBC = '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16' as const;
const RADIUS_SBC = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' as const;
const TX = '0x' + 'ab'.repeat(32);
const PAYOUT = '0x' + 'cd'.repeat(32);

const INSTRUCTIONS = {
  version: '1',
  environment: 'testnet',
  overview: 'Swap testnet stablecoins.',
  supported_routes: [
    { source_chain: 'base_sepolia', source_token: 'SBC', destination_chain: 'radius_testnet', destination_token: 'SBC', source_chain_id: 84532, source_token_contract: BASE_SEPOLIA_SBC, source_token_decimals: 6, destination_chain_id: 72344, destination_token_contract: RADIUS_SBC, destination_token_decimals: 6 },
    { source_chain: 'radius_testnet', source_token: 'SBC', destination_chain: 'base_sepolia', destination_token: 'SBC', source_chain_id: 72344, source_token_contract: RADIUS_SBC, source_token_decimals: 6, destination_chain_id: 84532, destination_token_contract: BASE_SEPOLIA_SBC, destination_token_decimals: 6 },
  ],
  steps: [{ step: 1, name: 'Sign a swap intent', description: '…' }],
  important_rules: ['Never modify unsigned_tx; sign the prepared fields exactly as returned'],
  error_codes: [{ code: 'RATE_LIMITED', description: 'Too many', caller_action: 'Wait' }],
};
const UNSIGNED_TX = { to: BASE_SEPOLIA_SBC, data: '0xa9059cbb' + '0'.repeat(128), value: '0x0', chainId: 84532, type: 'legacy', nonce: '0x7', gas: '0x186a0', gasPrice: '0x3b9aca00' };

interface Call { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown> }
const envelope = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, request_id: 'req_test', ...extra } });

/** A swap API that verifies intents like the server, hands out tokens, and walks a scripted status sequence. */
function swapApi(opts: { statuses?: Partial<SwapStatus & { payout_tx?: string }>[]; errors?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>; environment?: string } = {}) {
  const calls: Call[] = [];
  const errors = [...(opts.errors ?? [])];
  const statusQueue = [...(opts.statuses ?? [])];
  const env = opts.environment ?? 'testnet';
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const call: Call = { method: req.method, url: req.url, headers: Object.fromEntries(req.headers) };
    if (req.method === 'POST') call.body = JSON.parse(await req.text());
    calls.push(call);
    const next = errors.shift();
    if (next) return Response.json(next.body, { status: next.status, headers: next.headers });
    const path = u.pathname.replace('/api/v1/swap', '');
    const auth = req.headers.get('authorization');
    if (path === '/instructions') return Response.json({ ...INSTRUCTIONS, environment: env });
    if (path === '/prepare') {
      const b = call.body!;
      const route = INSTRUCTIONS.supported_routes.find((r) => r.source_chain === b.source_chain && r.source_token === b.source_token && r.destination_chain === b.destination_chain && r.destination_token === b.destination_token);
      if (!route) return Response.json(envelope('UNSUPPORTED_ROUTE', 'no such route'), { status: 400 });
      const recovered = await recoverTypedDataAddress({
        ...swapIntentTypedData(b as never, route.source_chain_id, env as 'testnet'),
        signature: b.signature as Hex,
      });
      if (recovered.toLowerCase() !== String(b.source_address).toLowerCase()) return Response.json(envelope('INVALID_SIGNATURE', 'Signature does not match the source_address in the swap intent.'), { status: 400 });
      return Response.json({
        swap_token: 'prepared.jwt',
        swap_token_expires_at: '2026-09-20T12:06:00Z',
        prepared_tx_expires_at: '2026-09-20T12:05:00Z',
        deposit_address: DEPOSIT,
        deposit_token_address: route.source_token_contract,
        deposit_chain: route.source_chain,
        deposit_token: route.source_token,
        destination_chain: route.destination_chain,
        destination_token: route.destination_token,
        payout_token_address: route.destination_token_contract,
        amount: b.amount,
        unsigned_tx: UNSIGNED_TX,
      });
    }
    if (path === '/broadcast') {
      if (auth !== 'Bearer prepared.jwt') return Response.json(envelope('UNAUTHORIZED', 'bad token'), { status: 401 });
      return Response.json({ session_id: 'sess_abc123', swap_token: 'status.jwt', swap_token_expires_at: '2026-09-20T12:15:00Z', tx_hash: TX, status: 'pending_broadcast' });
    }
    if (path === '/status') {
      if (auth !== 'Bearer status.jwt' && auth !== 'Bearer prepared.jwt') return Response.json(envelope('TOKEN_EXPIRED', 'expired'), { status: 401 });
      const s = statusQueue.length > 1 ? statusQueue.shift()! : (statusQueue[0] ?? { status: 'complete' });
      return Response.json({
        kind: 'session', session_id: 'sess_abc123', status: s.status ?? 'complete', source_chain: 'base_sepolia', source_token: 'SBC', source_address: ADDR, destination_address: DEST,
        destination_chain: 'radius_testnet', destination_token: 'SBC', deposit_address: DEPOSIT, deposit_token_address: BASE_SEPOLIA_SBC, payout_token_address: RADIUS_SBC, amount: '1.5',
        tx_hash: TX, payout_tx: s.payout_tx, created_at: '2026-09-20T12:00:00Z', updated_at: '2026-09-20T12:01:00Z',
        ...(s.status === 'failed' ? { error: { code: 'SOURCE_PREFLIGHT_FAILED', message: 'reverted', request_id: 'req_fail' } } : {}),
      });
    }
    if (path === '/sessions/token') {
      const b = call.body!;
      const recovered = await recoverTypedDataAddress({ ...swapSessionListAccessTypedData(b.source_address as never, b.expires_at as number, env as 'testnet'), signature: b.signature as Hex });
      if (recovered.toLowerCase() !== String(b.source_address).toLowerCase()) return Response.json(envelope('INVALID_SIGNATURE', 'nope'), { status: 400 });
      return Response.json({ swap_token: 'list.jwt', swap_token_expires_at: '2026-09-20T12:15:00Z' });
    }
    if (path === '/sessions') {
      if (auth !== 'Bearer list.jwt') return Response.json(envelope('UNAUTHORIZED', 'bad token'), { status: 401 });
      return Response.json({
        items: [
          { kind: 'prepared', session_id: 'sess_prep', status: 'prepared', source_chain: 'base_sepolia', source_token: 'SBC', source_address: ADDR, destination_address: DEST, destination_chain: 'radius_testnet', destination_token: 'SBC', deposit_address: DEPOSIT, amount: '1.5', unsigned_tx: UNSIGNED_TX, prepared_tx_expires_at: '2026-09-20T12:05:00Z', swap_token: 'prepared2.jwt', swap_token_expires_at: '2026-09-20T12:06:00Z', created_at: '2026-09-20T12:00:00Z' },
          { kind: 'session', session_id: 'sess_abc123', status: 'complete', tx_hash: TX, payout_tx: PAYOUT, amount: '1.5', completed_at: '2026-09-20T12:03:00Z' },
        ],
        next_cursor: u.searchParams.get('cursor') ? undefined : 'cursor-2',
      });
    }
    return Response.json(envelope('NOT_FOUND', 'No route matches the requested path.'), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace('/api/v1/swap', '')}${new URL(c.url).search}`);

afterEach(() => vi.useRealTimers());

describe('createSwapClient', () => {
  it('resolves the swap URL and environment from the network', async () => {
    expect(createSwapClient({ network: 'testnet' }).url).toBe('https://testnet.radiustech.xyz/api/v1/swap');
    expect(createSwapClient().url).toBe('https://network.radiustech.xyz/api/v1/swap');
    expect(createSwapClient({ network: 'testnet', swapUrl: 'https://proxy.test/swap/' }).url).toBe('https://proxy.test/swap');
    expect(createSwapClient({ url: 'https://x.test/swap', network: 'testnet' }).network).toBe(radiusTestnet);
    expect(await createSwapClient({ network: 'testnet' }).environment()).toBe('testnet');
    expect(await createSwapClient({ network: 'mainnet', environment: 'testnet' }).environment()).toBe('testnet');
    // Bare URL: the environment comes from /instructions.
    const api = swapApi({ environment: 'mainnet' });
    expect(await createSwapClient({ url: URL_, fetch: api.fetch }).environment()).toBe('mainnet');
    const none = resolveNetwork({ chainId: 4242, rpcUrl: 'https://rpc.test', facilitatorUrl: 'https://fac.test' });
    expect(() => createSwapClient({ network: none })).toThrow(SwapError);
    expect(() => createSwapClient({ network: none })).toThrow(/No swap API/);
  });

  it('instructions() parses routes and is fetched once', async () => {
    const api = swapApi();
    const client = createSwapClient({ url: URL_, fetch: api.fetch });
    const ins = await client.instructions();
    expect(ins.environment).toBe('testnet');
    expect(ins.routes).toHaveLength(2);
    expect(ins.routes[0]).toEqual({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', sourceChainId: 84532, sourceTokenContract: BASE_SEPOLIA_SBC, sourceTokenDecimals: 6, destinationChainId: 72344, destinationTokenContract: RADIUS_SBC, destinationTokenDecimals: 6 });
    expect(ins.importantRules[0]).toMatch(/Never modify unsigned_tx/);
    expect(ins.errorCodes[0]).toEqual({ code: 'RATE_LIMITED', description: 'Too many', callerAction: 'Wait' });
    await client.routes();
    expect(await client.route({ sourceChain: 'radius_testnet', sourceToken: 'SBC', destinationChain: 'base_sepolia', destinationToken: 'SBC' })).toMatchObject({ sourceChainId: 72344 });
    expect(paths(api.calls)).toEqual(['GET /instructions']);
    const err = await client.route({ sourceChain: 'base', sourceToken: 'USDC', destinationChain: 'radius', destinationToken: 'SBC' }).catch((e) => e);
    expect(err).toBeInstanceOf(SwapError);
    expect(err).toMatchObject({ code: 'swap', swapCode: 'UNSUPPORTED_ROUTE' });
    expect(err.message).toMatch(/supported: base_sepolia\/SBC → radius_testnet\/SBC/);
  });

  it('prepare() signs the SwapIntent with the route chain id and posts the documented body', async () => {
    const api = swapApi();
    const client = createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch });
    const prepared = await client.prepare({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1.5', destinationAddress: DEST, idempotencyKey: 'idem_test', expiresAt: 1_900_000_000 }, ACCOUNT);
    expect(paths(api.calls)).toEqual(['GET /instructions', 'POST /prepare']);
    const body = api.calls[1].body!;
    expect(body).toEqual({
      source_chain: 'base_sepolia', source_token: 'SBC', destination_chain: 'radius_testnet', destination_token: 'SBC',
      source_address: ADDR, destination_address: DEST, amount: '1.5', idempotency_key: 'idem_test', expires_at: 1_900_000_000,
      signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
    });
    expect(prepared).toMatchObject({
      swapToken: 'prepared.jwt', depositAddress: DEPOSIT, depositTokenAddress: BASE_SEPOLIA_SBC, depositChain: 'base_sepolia', depositToken: 'SBC',
      destinationChain: 'radius_testnet', destinationToken: 'SBC', payoutTokenAddress: RADIUS_SBC, amount: '1.5', unsignedTx: UNSIGNED_TX,
    });
    expect(prepared.swapTokenExpiresAt).toEqual(new Date('2026-09-20T12:06:00Z'));
    expect(prepared.preparedTxExpiresAt).toEqual(new Date('2026-09-20T12:05:00Z'));
    expect(toSignableTransaction(prepared.unsignedTx)).toEqual({ to: BASE_SEPOLIA_SBC, data: UNSIGNED_TX.data, value: 0n, chainId: 84532, type: 'legacy', nonce: 7, gas: 100_000n, gasPrice: 1_000_000_000n });
  });

  it('prepare() defaults: destination = source = signer, idempotency key and 5-minute expiry; environment override changes the signature domain', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00Z') });
    const api = swapApi();
    await createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch }).prepare({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '2' }, ACCOUNT);
    const body = api.calls[1].body!;
    expect(body.source_address).toBe(ADDR);
    expect(body.destination_address).toBe(ADDR);
    expect(body.idempotency_key).toMatch(/^idem_[0-9a-f]{32}$/);
    expect(body.expires_at).toBe(Math.floor(Date.parse('2026-09-20T12:05:00Z') / 1000));
    // Signed for 'mainnet' while the API verifies 'testnet' → INVALID_SIGNATURE from the server.
    const wrong = createSwapClient({ url: URL_, network: 'testnet', environment: 'mainnet', fetch: swapApi().fetch });
    await expect(wrong.prepare({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '2' }, ACCOUNT)).rejects.toMatchObject({ swapCode: 'INVALID_SIGNATURE', status: 400, requestId: 'req_test' });
  });

  it('prepare() validates locally before signing anything', async () => {
    const api = swapApi();
    const client = createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch });
    const intent = { sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC' } as const;
    await expect(client.prepare({ ...intent, amount: '$1' }, ACCOUNT)).rejects.toMatchObject({ swapCode: 'INVALID_AMOUNT' });
    await expect(client.prepare({ ...intent, amount: '1.', }, ACCOUNT)).rejects.toMatchObject({ swapCode: 'INVALID_AMOUNT' });
    await expect(client.prepare({ ...intent, amount: '1', destinationAddress: '0x12' as never }, ACCOUNT)).rejects.toMatchObject({ swapCode: 'INVALID_REQUEST' });
    await expect(client.prepare({ ...intent, sourceChain: 'base', amount: '1' }, ACCOUNT)).rejects.toMatchObject({ swapCode: 'UNSUPPORTED_ROUTE' });
    await expect(client.prepare({ ...intent, amount: '1' }, { address: ADDR } as never)).rejects.toMatchObject({ swapCode: 'SIGNER_REQUIRED' });
    expect(paths(api.calls).filter((p) => p.startsWith('POST'))).toEqual([]);
  });

  it('broadcast() sends the signed transaction under the prepared token', async () => {
    const api = swapApi();
    const client = createSwapClient({ url: URL_, fetch: api.fetch });
    const b = await client.broadcast('prepared.jwt', '0xf86c' as Hex);
    expect(b).toMatchObject({ sessionId: 'sess_abc123', swapToken: 'status.jwt', txHash: TX, status: 'pending_broadcast' });
    expect(b.swapTokenExpiresAt).toEqual(new Date('2026-09-20T12:15:00Z'));
    expect(api.calls[0]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer prepared.jwt', 'content-type': 'application/json' }), body: { signed_tx: '0xf86c' } });
    await expect(client.broadcast('prepared.jwt', 'nothex' as Hex)).rejects.toMatchObject({ swapCode: 'INVALID_SIGNED_TX' });
    await expect(client.broadcast('other.jwt', '0xf86c' as Hex)).rejects.toMatchObject({ swapCode: 'UNAUTHORIZED', status: 401 });
  });

  it('status() maps the session fields, dates, hashes and error', async () => {
    const api = swapApi({ statuses: [{ status: 'failed' }] });
    const s = await createSwapClient({ url: URL_, fetch: api.fetch }).status('status.jwt');
    expect(api.calls[0].headers.authorization).toBe('Bearer status.jwt');
    expect(s).toMatchObject({ kind: 'session', sessionId: 'sess_abc123', status: 'failed', sourceChain: 'base_sepolia', sourceAddress: ADDR, destinationAddress: DEST, depositAddress: DEPOSIT, amount: '1.5', txHash: TX, error: { code: 'SOURCE_PREFLIGHT_FAILED', message: 'reverted', requestId: 'req_fail' } });
    expect(s.payoutTx).toBeUndefined();
    expect(s.createdAt).toEqual(new Date('2026-09-20T12:00:00Z'));
    await expect(createSwapClient({ url: URL_, fetch: swapApi().fetch }).status('stale.jwt')).rejects.toMatchObject({ swapCode: 'TOKEN_EXPIRED', status: 401 });
  });

  it('sessionListToken() signs SwapSessionListAccess (no chainId) and listSessions() passes the query', async () => {
    const api = swapApi();
    const client = createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch });
    const t = await client.sessionListToken(ACCOUNT, { expiresAt: new Date('2026-09-20T12:10:00Z') });
    expect(t).toMatchObject({ swapToken: 'list.jwt' });
    expect(api.calls[0].body).toEqual({ source_address: ADDR, expires_at: Math.floor(Date.parse('2026-09-20T12:10:00Z') / 1000), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
    const list = await client.listSessions(t.swapToken, { limit: 10, status: 'prepared', sourceChain: 'base_sepolia', txHash: TX as Hex });
    expect(paths(api.calls)[1]).toBe(`GET /sessions?limit=10&status=prepared&source_chain=base_sepolia&tx_hash=${TX}`);
    expect(api.calls[1].headers.authorization).toBe('Bearer list.jwt');
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ kind: 'prepared', status: 'prepared', unsignedTx: UNSIGNED_TX, swapToken: 'prepared2.jwt' });
    expect(list.items[1]).toMatchObject({ kind: 'session', status: 'complete', payoutTx: PAYOUT });
    expect(list.items[1].completedAt).toEqual(new Date('2026-09-20T12:03:00Z'));
    expect(list.nextCursor).toBe('cursor-2');
    const page2 = await client.listSessions(t.swapToken, { cursor: list.nextCursor });
    expect(paths(api.calls)[2]).toBe('GET /sessions?cursor=cursor-2');
    expect(page2.nextCursor).toBeUndefined();
  });

  it('waitForCompletion() polls no faster than 3 s, stops at a terminal status, and can wait for the payout', async () => {
    vi.useFakeTimers();
    const api = swapApi({ statuses: [{ status: 'pending_deposit' }, { status: 'processing' }, { status: 'complete' }, { status: 'complete', payout_tx: PAYOUT }] });
    const seen: SwapFlowStatus[] = [];
    const p = createSwapClient({ url: URL_, fetch: api.fetch }).waitForCompletion('status.jwt', { intervalMs: 100, untilPayout: true, onStatus: (s) => seen.push(s.status) });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6_000);
    const final = await p;
    expect(final).toMatchObject({ status: 'complete', payoutTx: PAYOUT });
    expect(seen).toEqual(['pending_deposit', 'processing', 'complete', 'complete']);
    expect(api.calls).toHaveLength(4);
    // Without untilPayout the first `complete` ends the wait; `failed` is terminal and returned, not thrown.
    const quick = swapApi({ statuses: [{ status: 'complete' }, { status: 'complete', payout_tx: PAYOUT }] });
    expect((await createSwapClient({ url: URL_, fetch: quick.fetch }).waitForCompletion('status.jwt')).payoutTx).toBeUndefined();
    const failed = swapApi({ statuses: [{ status: 'failed' }] });
    expect((await createSwapClient({ url: URL_, fetch: failed.fetch }).waitForCompletion('status.jwt')).status).toBe('failed');
  });

  it('waitForCompletion() times out with TIMEOUT', async () => {
    vi.useFakeTimers();
    const api = swapApi({ statuses: [{ status: 'processing' }] });
    const p = createSwapClient({ url: URL_, fetch: api.fetch }).waitForCompletion('status.jwt', { timeoutMs: 7_000 });
    const result = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await result;
    expect(err).toBeInstanceOf(SwapError);
    expect(err).toMatchObject({ swapCode: 'TIMEOUT' });
    expect((err.details as SwapStatus).status).toBe('processing');
    // Polls at 0, 3, 6 s, then once more at the 7 s deadline before giving up.
    expect(api.calls).toHaveLength(4);
  });

  it('swap() runs prepare → sign → broadcast → wait; the signed transaction preserves every prepared field', async () => {
    vi.useFakeTimers();
    const api = swapApi({ statuses: [{ status: 'pending_deposit' }, { status: 'complete' }] });
    const client = createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch });
    const p = client.swap({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1.5', destinationAddress: DEST }, ACCOUNT);
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await p;
    expect(paths(api.calls)).toEqual(['GET /instructions', 'POST /prepare', 'POST /broadcast', 'GET /status', 'GET /status']);
    expect(result.broadcast.sessionId).toBe('sess_abc123');
    expect(result.status?.status).toBe('complete');
    const signed = parseTransaction(api.calls[2].body!.signed_tx as Hex);
    expect(signed).toMatchObject({ type: 'legacy', to: BASE_SEPOLIA_SBC.toLowerCase(), data: UNSIGNED_TX.data, chainId: 84532, nonce: 7, gas: 100_000n, gasPrice: 1_000_000_000n });
    expect(signed.value ?? 0n).toBe(0n);
    // wait: false returns right after broadcast.
    const api2 = swapApi();
    const r2 = await createSwapClient({ url: URL_, network: 'testnet', fetch: api2.fetch }).swap({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1' }, ACCOUNT, { wait: false });
    expect(r2.status).toBeUndefined();
    expect(paths(api2.calls)).toEqual(['GET /instructions', 'POST /prepare', 'POST /broadcast']);
  });

  it('swap() throws SWAP_FAILED on a failed session and SIGNER_REQUIRED without signTransaction', async () => {
    const api = swapApi({ statuses: [{ status: 'failed' }] });
    const client = createSwapClient({ url: URL_, network: 'testnet', fetch: api.fetch });
    const err = await client.swap({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1' }, ACCOUNT).catch((e) => e);
    expect(err).toMatchObject({ swapCode: 'SWAP_FAILED' });
    expect(err.message).toMatch(/sess_abc123 failed: SOURCE_PREFLIGHT_FAILED reverted/);
    const typedOnly = { address: ADDR, signTypedData: ACCOUNT.signTypedData.bind(ACCOUNT) };
    await expect(client.swap({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1' }, typedOnly)).rejects.toMatchObject({ swapCode: 'SIGNER_REQUIRED' });
    // prepare() alone works with a typed-data-only signer; signing the prepared tx does not.
    const prepared = await client.prepare({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1' }, typedOnly);
    await expect(client.signPrepared(prepared, typedOnly)).rejects.toMatchObject({ swapCode: 'SIGNER_REQUIRED' });
  });

  it('maps the error envelope to SwapError (code, status, request id, retry, details) and tolerates non-JSON', async () => {
    const cases: Array<[number, unknown, Record<string, string>, Record<string, unknown>]> = [
      [429, envelope('RATE_LIMITED', 'slow down', { retry_after_ms: 30000 }), {}, { swapCode: 'RATE_LIMITED', status: 429, retryAfterMs: 30000, requestId: 'req_test' }],
      [429, envelope('RATE_LIMITED', 'slow down'), { 'retry-after': '7' }, { retryAfterMs: 7000 }],
      [409, envelope('ACTIVE_PREPARED_TX_EXISTS', 'busy', { details: { session_id: 'sess_x' } }), {}, { swapCode: 'ACTIVE_PREPARED_TX_EXISTS', status: 409, errorDetails: { session_id: 'sess_x' } }],
      [400, envelope('INSUFFICIENT_GAS', 'fund gas'), {}, { swapCode: 'INSUFFICIENT_GAS' }],
      [403, envelope('ADDRESS_BLOCKED', 'blocked'), {}, { swapCode: 'ADDRESS_BLOCKED', status: 403 }],
      [500, envelope('INTERNAL_ERROR', 'boom'), {}, { swapCode: 'INTERNAL_ERROR', status: 500 }],
      [404, {}, { 'x-request-id': 'req_hdr' }, { swapCode: 'NOT_FOUND', requestId: 'req_hdr' }],
      [502, 'Bad Gateway', {}, { swapCode: 'INTERNAL_ERROR', status: 502 }],
    ];
    for (const [status, body, headers, expected] of cases) {
      const api = swapApi({ errors: [{ status, body, headers }] });
      const err = await createSwapClient({ url: URL_, fetch: api.fetch }).status('status.jwt').catch((e) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(SwapError);
      expect(err).toBeInstanceOf(RadiusPaymentError);
      expect(err).toMatchObject({ code: 'swap', ...expected });
      expect(err.details).toEqual(body);
    }
    const e = await createSwapClient({ url: URL_, fetch: swapApi({ errors: [{ status: 429, body: envelope('RATE_LIMITED', 'slow down', { retry_after_ms: 30000 }) }] }).fetch }).status('x').catch((e) => e);
    expect(e.message).toBe('Swap API RATE_LIMITED (HTTP 429): slow down (retry in 30 s) [req_test]');
    const html = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof globalThis.fetch;
    await expect(createSwapClient({ url: URL_, fetch: html }).status('x')).rejects.toMatchObject({ swapCode: 'INVALID_RESPONSE' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch;
    await expect(createSwapClient({ url: URL_, fetch: down }).instructions()).rejects.toMatchObject({ swapCode: 'INVALID_RESPONSE', status: 0 });
    // A failed /instructions is not cached.
    const flaky = swapApi({ errors: [{ status: 500, body: envelope('INTERNAL_ERROR', 'boom') }] });
    const c = createSwapClient({ url: URL_, fetch: flaky.fetch });
    await expect(c.instructions()).rejects.toMatchObject({ swapCode: 'INTERNAL_ERROR' });
    expect((await c.instructions()).environment).toBe('testnet');
  });
});

describe('createRadiusFetch().swap', () => {
  it('exposes the network swap client sharing the fetch, and radiusEnv maps RADIUS_SWAP_URL', async () => {
    const api = swapApi();
    const buyer = createRadiusFetch({ network: 'testnet', signer: PK, maxPerRequest: '$0.01', fetch: api.fetch, swapUrl: URL_ });
    expect(buyer.swap?.url).toBe(URL_);
    expect((await buyer.swap!.routes()).length).toBe(2);
    const none = createRadiusFetch({ network: { chainId: 4242, rpcUrl: 'https://rpc.test', facilitatorUrl: 'https://fac.test' }, signer: PK, maxPerRequest: '$0.01' });
    expect(none.swap).toBeUndefined();
    expect(radiusEnv({ RADIUS_NETWORK: 'testnet', RADIUS_SWAP_URL: 'https://proxy.test/swap' })).toEqual({ network: 'testnet', swapUrl: 'https://proxy.test/swap' });
  });
});
