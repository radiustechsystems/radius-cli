/**
 * Faucet client against a mock of the faucet API (status / challenge / drip, error catalogue),
 * plus `createRadiusFetch().fund()` delegating to it.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { createFaucetClient, FaucetError } from '../src/faucet.js';
import { createRadiusFetch } from '../src/client/index.js';
import { RadiusPaymentError, radiusTestnet, radiusEnv, resolveNetwork } from '../src/index.js';

const PK = ('0x' + '11'.repeat(32)) as `0x${string}`;
const ACCOUNT = privateKeyToAccount(PK);
const ADDR = ACCOUNT.address;
const URL_ = 'https://faucet.test/api/v1/faucet';

interface Call { method: string; url: string; body?: Record<string, unknown> }

/** A faucet that can be switched between unsigned and signed mode, with a scripted error queue. */
/** The Radius API error envelope. */
const envelope = (code: string, message: string, extra: { retry_after_ms?: number; details?: Record<string, unknown> } = {}) => ({ error: { code, message, request_id: 'req_test', ...extra } });

function faucet(opts: { requireSignature?: boolean; challengeInError?: boolean; errors?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>; challenge?: string } = {}) {
  const calls: Call[] = [];
  const message = opts.challenge ?? `Radius Faucet: drip SBC to ${ADDR}`;
  const errors = [...(opts.errors ?? [])];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const call: Call = { method: req.method, url: req.url };
    if (req.method === 'POST') call.body = JSON.parse(await req.text());
    calls.push(call);
    const next = errors.shift();
    if (next) return Response.json(next.body, { status: next.status, headers: next.headers });
    if (u.pathname.endsWith(`/status/${ADDR}`)) {
      return Response.json({ address: ADDR.toLowerCase(), token: u.searchParams.get('token'), rate_limited: false, retry_after_ms: null, remaining_requests: 60, drip_amount: '0.5', native_drip_amount: '0.001' });
    }
    if (u.pathname.endsWith(`/challenge/${ADDR}`)) {
      return Response.json({ message, address: ADDR.toLowerCase(), token: 'SBC', instructions: 'Sign the "message" field with personal_sign (EIP-191)' });
    }
    if (u.pathname.endsWith('/drip')) {
      const body = call.body!;
      if (opts.requireSignature) {
        if (typeof body.signature !== 'string') {
          const details = opts.challengeInError === false ? undefined : { challenge: message };
          return Response.json(envelope('signature_required', 'A signed challenge is required.', { details }), { status: 400 });
        }
        const ok = await verifyMessage({ address: ADDR, message, signature: body.signature as `0x${string}` });
        if (!ok) return Response.json(envelope('invalid_signature', 'Signature does not match the provided address.'), { status: 400 });
      }
      return Response.json({ success: true, address: body.address, token: body.token, amount: '0.5', tx_hash: '0x' + 'ab'.repeat(32), native: { token: 'RUSD', amount: '0.001', tx_hash: '0x' + 'cd'.repeat(32) }, next_drip_at: 1_800_000_000 });
    }
    return Response.json(envelope('not_found', 'No route matches the requested path.'), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createFaucetClient', () => {
  it('resolves the faucet URL and token from the network', () => {
    expect(createFaucetClient({ network: 'testnet' }).url).toBe('https://testnet.radiustech.xyz/api/v1/faucet');
    expect(createFaucetClient({ network: 'testnet' }).token).toBe('SBC');
    expect(createFaucetClient().url).toBe('https://network.radiustech.xyz/api/v1/faucet');
    expect(createFaucetClient({ network: 'testnet', faucetUrl: 'https://proxy.test/faucet/' }).url).toBe('https://proxy.test/faucet');
    expect(createFaucetClient({ url: 'https://x.test/faucet/', token: 'USDX' })).toMatchObject({ url: 'https://x.test/faucet', token: 'USDX', network: undefined });
    expect(createFaucetClient({ url: 'https://x.test/faucet', network: 'testnet' }).network).toBe(radiusTestnet);
    const none = resolveNetwork({ chainId: 4242, rpcUrl: 'https://rpc.test', facilitatorUrl: 'https://fac.test' });
    expect(() => createFaucetClient({ network: none })).toThrow(FaucetError);
    expect(() => createFaucetClient({ network: none })).toThrow(/No faucet configured/);
  });

  it('GET /status parses the documented fields', async () => {
    const f = faucet();
    const client = createFaucetClient({ url: URL_, fetch: f.fetch });
    const s = await client.status(ADDR);
    expect(s).toMatchObject({ address: ADDR.toLowerCase(), token: 'SBC', rateLimited: false, remainingRequests: 60, dripAmount: '0.5', nativeDripAmount: '0.001' });
    expect(s.retryAfterMs).toBeUndefined();
    expect(s.unlimited).toBeUndefined();
    const unlimited = createFaucetClient({ url: URL_, fetch: faucet({ errors: [{ status: 200, body: { address: ADDR, token: 'SBC', rate_limited: false, retry_after_ms: null, remaining_requests: null, drip_amount: '0.5', native_drip_amount: null, unlimited: true } }] }).fetch });
    const u = await unlimited.status(ADDR);
    expect(u).toMatchObject({ rateLimited: false, unlimited: true });
    expect(u.remainingRequests).toBeUndefined();
    expect(u.nativeDripAmount).toBeUndefined();
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${URL_}/status/${ADDR}?token=SBC` });
    const limited = createFaucetClient({ url: URL_, fetch: faucet({ errors: [{ status: 200, body: { address: ADDR, token: 'SBC', rate_limited: true, retry_after_ms: 42000, remaining_requests: 0, drip_amount: '0.5' } }] }).fetch });
    expect(await limited.status(ADDR)).toMatchObject({ rateLimited: true, retryAfterMs: 42000, remainingRequests: 0 });
  });

  it('GET /challenge returns the message to sign and nothing is interpreted', async () => {
    const f = faucet();
    const c = await createFaucetClient({ url: URL_, fetch: f.fetch }).challenge(ADDR);
    expect(c.message).toBe(`Radius Faucet: drip SBC to ${ADDR}`);
    expect(c).not.toHaveProperty('instructions');
    expect((c.raw as { instructions: string }).instructions).toMatch(/personal_sign/);
  });

  it('drip() posts { address, token[, signature] } and maps the success body', async () => {
    const f = faucet();
    const client = createFaucetClient({ network: 'testnet', url: URL_, fetch: f.fetch });
    const d = await client.drip(ADDR);
    expect(d).toMatchObject({ success: true, address: ADDR, token: 'SBC', amount: '0.5', txHash: '0x' + 'ab'.repeat(32), explorerUrl: `https://testnet.radiustech.xyz/tx/0x${'ab'.repeat(32)}`, native: { token: 'RUSD', amount: '0.001', txHash: '0x' + 'cd'.repeat(32) }, nextDripAt: 1_800_000_000 });
    expect(f.calls[0].body).toEqual({ address: ADDR, token: 'SBC' });
    await client.drip(ADDR, '0xsig');
    expect(f.calls[1].body).toEqual({ address: ADDR, token: 'SBC', signature: '0xsig' });
    expect(f.calls[1].method).toBe('POST');
  });

  it('rejects malformed addresses before any request', async () => {
    const f = faucet();
    const client = createFaucetClient({ url: URL_, fetch: f.fetch });
    await expect(client.drip('0x123' as `0x${string}`)).rejects.toMatchObject({ faucetCode: 'invalid_address' });
    await expect(client.status('nope' as `0x${string}`)).rejects.toBeInstanceOf(FaucetError);
    expect(f.calls).toHaveLength(0);
  });

  it('fund() drips unsigned when the faucet allows it (no challenge, no signature)', async () => {
    const f = faucet();
    const d = await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR, { signer: ACCOUNT });
    expect(d.success).toBe(true);
    expect(f.calls.map((c) => new URL(c.url).pathname.split('/').at(-1))).toEqual(['drip']);
    expect(f.calls[0].body).not.toHaveProperty('signature');
  });

  it('fund() falls back to sign → drip on signature_required, using the challenge from error.details', async () => {
    const f = faucet({ requireSignature: true });
    const d = await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR, { signer: ACCOUNT });
    expect(d).toMatchObject({ success: true, amount: '0.5' });
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(URL_.replace('https://faucet.test', ''), '')}`)).toEqual(['POST /drip', 'POST /drip']);
    const signed = f.calls[1].body!;
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await verifyMessage({ address: ADDR, message: `Radius Faucet: drip SBC to ${ADDR}`, signature: signed.signature as `0x${string}` })).toBe(true);
  });

  it('fund() fetches GET /challenge when signature_required carries no challenge', async () => {
    const f = faucet({ requireSignature: true, challengeInError: false });
    await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR, { signer: ACCOUNT });
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(URL_.replace('https://faucet.test', ''), '')}`)).toEqual([
      'POST /drip',
      `GET /challenge/${ADDR}`,
      'POST /drip',
    ]);
  });

  it("fund({ signature: 'always' }) skips the unsigned attempt; 'never' surfaces signature_required", async () => {
    const f = faucet({ requireSignature: true });
    await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR, { signer: ACCOUNT, signature: 'always' });
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    const g = faucet({ requireSignature: true });
    const err = await createFaucetClient({ url: URL_, fetch: g.fetch }).fund(ADDR, { signer: ACCOUNT, signature: 'never' }).catch((e) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect(err).toMatchObject({ code: 'faucet', faucetCode: 'signature_required', status: 400 });
    expect(g.calls).toHaveLength(1);
  });

  it('fund() without a signer reports signer_required when the faucet wants a signature', async () => {
    const f = faucet({ requireSignature: true });
    const err = await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR).catch((e) => e);
    expect(err).toMatchObject({ faucetCode: 'signer_required' });
    expect(err.message).toMatch(/signMessage/);
    expect(f.calls).toHaveLength(1);
  });

  it('fund() re-fetches the challenge and retries once on invalid_signature', async () => {
    // First signed drip: the faucet claims the signature is stale; second: accepted.
    const f = faucet({ requireSignature: true, errors: [
      { status: 400, body: envelope('signature_required', 'sign', { details: { challenge: 'stale challenge' } }) },
      { status: 400, body: envelope('invalid_signature', 'challenge expired') },
    ] });
    const d = await createFaucetClient({ url: URL_, fetch: f.fetch }).fund(ADDR, { signer: ACCOUNT });
    expect(d.success).toBe(true);
    expect(f.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'POST']);
    // Only one retry: a second invalid_signature is thrown.
    const g = faucet({ requireSignature: true, errors: [
      { status: 400, body: envelope('signature_required', 'sign', { details: { challenge: 'stale' } }) },
      { status: 400, body: envelope('invalid_signature', 'nope') },
      { status: 200, body: { message: 'stale again', address: ADDR, token: 'SBC' } },
      { status: 400, body: envelope('invalid_signature', 'nope') },
    ] });
    await expect(createFaucetClient({ url: URL_, fetch: g.fetch }).fund(ADDR, { signer: ACCOUNT })).rejects.toMatchObject({ faucetCode: 'invalid_signature' });
  });

  it('maps the error catalogue to FaucetError with retryAfterMs and the raw body', async () => {
    const cases: Array<[number, unknown, Record<string, unknown>]> = [
      [429, envelope('rate_limited', 'slow down', { retry_after_ms: 30000 }), { faucetCode: 'rate_limited', status: 429, retryAfterMs: 30000, requestId: 'req_test' }],
      [503, envelope('faucet_empty', 'dry'), { faucetCode: 'faucet_empty', status: 503 }],
      [503, envelope('sbc_not_configured', 'no SBC'), { faucetCode: 'sbc_not_configured' }],
      [503, envelope('faucet_not_configured', 'no wallet'), { faucetCode: 'faucet_not_configured' }],
      [500, envelope('transaction_reverted', 'reverted', { details: { tx_hash: '0x' + 'ee'.repeat(32) } }), { faucetCode: 'transaction_reverted', errorDetails: { tx_hash: '0x' + 'ee'.repeat(32) } }],
      [500, envelope('receipt_timeout', 'slow chain', { details: { tx_hash: '0x' + 'ee'.repeat(32) } }), { faucetCode: 'receipt_timeout', status: 500 }],
      [500, envelope('native_drip_failed', 'gas drip failed', { details: { tx_hash: '0x' + 'ee'.repeat(32) } }), { faucetCode: 'native_drip_failed' }],
      [500, envelope('internal_error', 'boom'), { faucetCode: 'internal_error', status: 500 }],
      [400, envelope('invalid_request', 'token: Invalid enum value'), { faucetCode: 'invalid_request' }],
      [405, envelope('method_not_allowed', 'use GET'), { faucetCode: 'method_not_allowed', status: 405 }],
      // Error-shaped body on a 200 is still an error.
      [200, { success: false, error: { code: 'faucet_empty', message: 'dry', request_id: 'req_1' } }, { faucetCode: 'faucet_empty', status: 200, requestId: 'req_1' }],
      // Flat `{ error: "code", message }` (older proxies) is tolerated.
      [404, { error: 'no_faucet', message: 'no faucet for devnet' }, { faucetCode: 'no_faucet', status: 404 }],
      [429, { error: 'rate_limited', retry_after_ms: 5000 }, { faucetCode: 'rate_limited', retryAfterMs: 5000 }],
      // No code at all: derive from the status.
      [429, {}, { faucetCode: 'rate_limited' }],
      [404, {}, { faucetCode: 'not_found' }],
      [502, 'Bad Gateway', { faucetCode: 'internal_error', status: 502 }],
    ];
    for (const [status, body, expected] of cases) {
      const f = faucet({ errors: [{ status, body }] });
      const err = await createFaucetClient({ url: URL_, fetch: f.fetch }).drip(ADDR).catch((e) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(FaucetError);
      expect(err).toBeInstanceOf(RadiusPaymentError);
      expect(err).toMatchObject({ code: 'faucet', ...expected });
      expect(err.details).toEqual(body);
    }
    const limited = faucet({ errors: [{ status: 429, body: envelope('rate_limited', 'slow down', { retry_after_ms: 30000 }), headers: { 'retry-after': '30' } }] });
    const e = await createFaucetClient({ url: URL_, fetch: limited.fetch }).drip(ADDR).catch((e) => e);
    expect(e.message).toBe('Faucet rate_limited (HTTP 429): slow down (retry in 30 s) [req_test]');
    // Retry-After header when the body has no retry_after_ms.
    const hdr = faucet({ errors: [{ status: 429, body: envelope('rate_limited', 'slow down'), headers: { 'retry-after': '7' } }] });
    await expect(createFaucetClient({ url: URL_, fetch: hdr.fetch }).drip(ADDR)).rejects.toMatchObject({ retryAfterMs: 7000 });
  });

  it('flags non-JSON and success-less bodies as invalid_response', async () => {
    const html = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof globalThis.fetch;
    await expect(createFaucetClient({ url: URL_, fetch: html }).drip(ADDR)).rejects.toMatchObject({ faucetCode: 'invalid_response' });
    const noSuccess = faucet({ errors: [{ status: 200, body: { address: ADDR } }] });
    await expect(createFaucetClient({ url: URL_, fetch: noSuccess.fetch }).drip(ADDR)).rejects.toMatchObject({ faucetCode: 'invalid_response' });
    const noMessage = faucet({ errors: [{ status: 200, body: { address: ADDR, token: 'SBC' } }] });
    await expect(createFaucetClient({ url: URL_, fetch: noMessage.fetch }).challenge(ADDR)).rejects.toMatchObject({ faucetCode: 'invalid_response' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch;
    await expect(createFaucetClient({ url: URL_, fetch: down }).status(ADDR)).rejects.toMatchObject({ faucetCode: 'invalid_response', status: 0 });
  });
});

describe('createRadiusFetch().fund()', () => {
  it('drips to the signer address through the network faucet, signing only when asked', async () => {
    const f = faucet({ requireSignature: true });
    const buyer = createRadiusFetch({ network: 'testnet', signer: PK, maxPerRequest: '$0.01', fetch: f.fetch });
    expect(buyer.faucet?.url).toBe('https://testnet.radiustech.xyz/api/v1/faucet');
    const d = await buyer.fund();
    expect(d).toMatchObject({ success: true, amount: '0.5', txHash: '0x' + 'ab'.repeat(32), explorerUrl: expect.stringContaining('https://testnet.radiustech.xyz/tx/') });
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://testnet.radiustech.xyz/api/v1/faucet/drip',
      'https://testnet.radiustech.xyz/api/v1/faucet/drip',
    ]);
    expect(f.calls[1].body).toMatchObject({ address: ADDR, token: 'SBC', signature: expect.stringMatching(/^0x/) });
  });

  it('honours faucetUrl overrides (e.g. a same-origin CORS proxy) and fund({ signature })', async () => {
    const f = faucet();
    const buyer = createRadiusFetch({ network: 'testnet', faucetUrl: 'https://dapp.test/faucet', signer: PK, maxPerRequest: '$0.01', fetch: f.fetch });
    await buyer.fund({ signature: 'always' });
    expect(f.calls.map((c) => c.url)).toEqual([`https://dapp.test/faucet/challenge/${ADDR}?token=SBC`, 'https://dapp.test/faucet/drip']);
    expect(await buyer.faucet!.status(ADDR)).toMatchObject({ dripAmount: '0.5' });
  });

  it('a typed-data-only signer can still drip unsigned, and gets signer_required otherwise', async () => {
    const typedOnly = { address: ADDR, signTypedData: async () => '0x' as `0x${string}` };
    const open = faucet();
    const buyer = createRadiusFetch({ network: 'testnet', signer: typedOnly, maxPerRequest: '$0.01', fetch: open.fetch });
    expect((await buyer.fund()).success).toBe(true);
    const strict = faucet({ requireSignature: true });
    const buyer2 = createRadiusFetch({ network: 'testnet', signer: typedOnly, maxPerRequest: '$0.01', fetch: strict.fetch });
    await expect(buyer2.fund()).rejects.toMatchObject({ code: 'faucet', faucetCode: 'signer_required' });
  });

  it('has no faucet on a network without one', async () => {
    const buyer = createRadiusFetch({ network: { chainId: 4242, rpcUrl: 'https://rpc.test', facilitatorUrl: 'https://fac.test' }, signer: PK, maxPerRequest: '$0.01' });
    expect(buyer.faucet).toBeUndefined();
    await expect(buyer.fund()).rejects.toMatchObject({ code: 'faucet', faucetCode: 'no_faucet' });
  });

  it('radiusEnv maps RADIUS_FAUCET_URL to faucetUrl', () => {
    expect(radiusEnv({ RADIUS_NETWORK: 'testnet', RADIUS_FAUCET_URL: 'https://proxy.test/faucet' })).toEqual({ network: 'testnet', faucetUrl: 'https://proxy.test/faucet' });
  });
});
