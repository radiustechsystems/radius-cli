/**
 * MPP (`WWW-Authenticate: Payment`, evm charge) on the client and the server, including interop
 * with mppx in both directions. Facilitator HTTP is stubbed on the global fetch; nothing touches a
 * chain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Challenge, Credential, Receipt } from 'mppx';
import { Mppx as MppxClient, evm as evmClient } from 'mppx/client';
import { Mppx as MppxServer, evm as evmServer } from 'mppx/server';
import { challengeHash } from 'mppx/evm';
import { createRadiusFetch, RadiusPaymentError, type PaymentOffer, type PaymentReceipt, type RadiusFetchOptions } from '../src/client/index.js';
import { radiusTestnet, SBC } from '../src/networks.js';
import { radiusPayments } from '../src/server/index.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SIGNER = privateKeyToAccount(PK);
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const SECRET = 'mpp-test-secret-0123456789abcdefghijklmnop';
const TX = `0x${'cd'.repeat(32)}`;
const FACILITATOR = 'https://facilitator.testnet.radiustech.xyz';
const URL_ = 'http://seller.test/api/lookup';
const SBC_DOMAIN = { name: 'Stable Coin', version: '1', chainId: 72344, verifyingContract: SBC.address } as const;
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const MPP_REQUEST = {
  amount: '1000',
  currency: SBC.address,
  recipient: PAY_TO,
  methodDetails: { chainId: 72344, credentialTypes: ['authorization'], decimals: 6 },
};

function mppChallenge(request: Record<string, unknown> = MPP_REQUEST, extra: Record<string, unknown> = {}) {
  return Challenge.from({ realm: 'seller.test', method: 'evm', intent: 'charge', request, expires: new Date(Date.now() + 300_000).toISOString(), secretKey: SECRET, ...extra } as never);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const x402Challenge = (accept: Record<string, unknown>) => ({ x402Version: 2, resource: { url: URL_ }, accepts: [accept] });
const X402_SBC = { scheme: 'exact', network: 'eip155:72344', asset: SBC.address, payTo: PAY_TO, amount: '1000', maxTimeoutSeconds: 60, extra: { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1' } };

/** A seller answering 402 with the given headers, then `paid()` once a credential arrives. */
function seller(headers: Record<string, string>, paid: () => Response = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.headers.has('payment-signature') || /^payment /i.test(req.headers.get('authorization') ?? '')) return paid();
    return new Response('{}', { status: 402, headers: headers });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function buyer(fetch: typeof globalThis.fetch, extra: Partial<RadiusFetchOptions> = {}) {
  const offers: PaymentOffer[] = [];
  const payFetch = createRadiusFetch({ network: 'testnet', signer: PK, maxPerRequest: '$0.01', fetch, onPaymentRequired: (o) => (offers.push(o), true), ...extra });
  return { payFetch, offers };
}

const rejects = (p: Promise<unknown>, code: string, message?: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof RadiusPaymentError && e.code === code && (!message || message.test(e.message)));

/** Stub the Radius testnet facilitator: records verify/settle bodies. */
function mockFacilitator(opts: { valid?: boolean; settle?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(FACILITATOR)) return real(input as RequestInfo, init);
    const body = req.method === 'POST' ? await req.json() : undefined;
    calls.push({ url: req.url, body });
    if (req.url.endsWith('/verify')) return Response.json(opts.valid === false ? { isValid: false, invalidReason: 'invalid_exact_evm_signature' } : { isValid: true, payer: SIGNER.address });
    if (req.url.endsWith('/settle')) return Response.json(opts.settle === false ? { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:72344' } : { success: true, transaction: TX, network: 'eip155:72344', payer: SIGNER.address });
    return new Response('not found', { status: 404 });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

// -- client --------------------------------------------------------------------------------------

describe('createRadiusFetch paying MPP challenges', () => {
  it('signs an EIP-3009 authorization bound to the challenge, in a credential mppx accepts', async () => {
    const c = mppChallenge();
    const s = seller({ 'WWW-Authenticate': Challenge.serialize(c) });
    const { payFetch, offers } = buyer(s.fetch);
    expect((await payFetch(URL_)).status).toBe(200);
    expect(offers[0]).toMatchObject({ protocol: 'mpp', scheme: 'exact', amount: '1000', amountFormatted: '0.001 SBC', payTo: PAY_TO, network: radiusTestnet, transferMethod: 'eip3009' });
    const credential = Credential.deserialize(s.requests[1].headers.get('authorization')!);
    expect(Challenge.verify(credential.challenge, { secretKey: SECRET })).toBe(true);
    expect(credential.source).toBe(`did:pkh:eip155:72344:${SIGNER.address}`);
    const p = credential.payload as Record<string, string>;
    expect(p).toMatchObject({ type: 'authorization', from: SIGNER.address, to: PAY_TO, value: '1000', validAfter: '0', nonce: challengeHash(c) });
    expect(Number(p.validBefore)).toBe(Math.floor(Date.parse(c.expires!) / 1000));
    const recovered = await recoverTypedDataAddress({
      domain: SBC_DOMAIN,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from: p.from as Address, to: p.to as Address, value: BigInt(p.value), validAfter: 0n, validBefore: BigInt(p.validBefore), nonce: p.nonce as Hex },
      signature: p.signature as Hex,
    });
    expect(recovered).toBe(SIGNER.address);
  });

  it('reads the Payment-Receipt', async () => {
    const receipt = Receipt.serialize(Receipt.from({ method: 'evm', reference: TX, status: 'success', timestamp: new Date().toISOString() }));
    const s = seller({ 'WWW-Authenticate': Challenge.serialize(mppChallenge()) }, () => Response.json({ ok: true }, { headers: { 'Payment-Receipt': receipt } }));
    let paid: PaymentReceipt | undefined;
    await buyer(s.fetch, { onPaid: (r) => void (paid = r) }).payFetch(URL_);
    expect(paid).toMatchObject({ success: true, protocol: 'mpp', transaction: TX, network: 'eip155:72344', amount: '1000', explorerUrl: `https://testnet.radiustech.xyz/tx/${TX}` });
  });

  it('prefers x402 when a 402 offers both, unless told otherwise', async () => {
    const headers = { 'PAYMENT-REQUIRED': b64(x402Challenge(X402_SBC)), 'WWW-Authenticate': Challenge.serialize(mppChallenge()) };
    const a = buyer(seller(headers).fetch);
    await a.payFetch(URL_);
    expect(a.offers[0].protocol).toBe('x402');
    const b = buyer(seller(headers).fetch, { protocols: ['mpp', 'x402'] });
    await b.payFetch(URL_);
    expect(b.offers[0].protocol).toBe('mpp');
  });

  it('falls back to MPP when the x402 offers do not fit, and never pays a protocol it was not given', async () => {
    const headers = { 'PAYMENT-REQUIRED': b64(x402Challenge({ ...X402_SBC, network: 'eip155:1' })), 'WWW-Authenticate': Challenge.serialize(mppChallenge()) };
    const a = buyer(seller(headers).fetch);
    await a.payFetch(URL_);
    expect(a.offers[0].protocol).toBe('mpp');
    await rejects(buyer(seller(headers).fetch, { protocols: ['x402'] }).payFetch(URL_), 'network_mismatch');
    await rejects(buyer(seller({ 'WWW-Authenticate': Challenge.serialize(mppChallenge()) }).fetch, { protocols: ['x402'] }).payFetch(URL_), 'invalid_challenge');
  });

  it('only ever sends the credential in Authorization', async () => {
    const s = seller({ 'WWW-Authenticate': Challenge.serialize(mppChallenge(MPP_REQUEST, { header: 'Cookie' })) });
    await rejects(buyer(s.fetch).payFetch(URL_), 'no_compatible_offer', /another credential header/);
    expect(s.requests).toHaveLength(1);
  });

  it('reports the reason an MPP server gives for rejecting the payment', async () => {
    const problem = { type: 'https://paymentauth.org/problems/verification-failed', title: 'Payment verification failed', status: 402, detail: 'authorization amount mismatch' };
    const s = seller({ 'WWW-Authenticate': Challenge.serialize(mppChallenge()) }, () => Response.json(problem, { status: 402, headers: { 'Content-Type': 'application/problem+json' } }));
    const err = await buyer(s.fetch).payFetch(URL_).catch((e: RadiusPaymentError) => e);
    expect(err).toMatchObject({ code: 'payment_rejected', message: 'Server rejected the payment (authorization amount mismatch)', details: { error: 'authorization amount mismatch' } });
    expect(await (err as RadiusPaymentError & { details: { response: Response } }).details.response.json()).toEqual(problem);
  });

  it('does not overwrite an Authorization header the request already carries', async () => {
    const s = seller({ 'WWW-Authenticate': Challenge.serialize(mppChallenge()) });
    await rejects(buyer(s.fetch).payFetch(URL_, { headers: { Authorization: 'Bearer api-key' } }), 'no_compatible_offer', /already sets/);
    expect(s.requests).toHaveLength(1);
  });

  it('refuses challenges it cannot pay before signing', async () => {
    const pay = (c: ReturnType<typeof mppChallenge>, extra: Partial<RadiusFetchOptions> = {}) => buyer(seller({ 'WWW-Authenticate': Challenge.serialize(c) }).fetch, extra).payFetch(URL_);
    await rejects(pay(mppChallenge({ ...MPP_REQUEST, methodDetails: { ...MPP_REQUEST.methodDetails, chainId: 1 } })), 'network_mismatch', /eip155:1/);
    await rejects(pay(mppChallenge({ ...MPP_REQUEST, currency: PAY_TO })), 'asset_mismatch');
    await rejects(pay(mppChallenge({ ...MPP_REQUEST, methodDetails: { ...MPP_REQUEST.methodDetails, credentialTypes: ['transaction'] } })), 'unsupported_transfer_method');
    await rejects(pay(mppChallenge({ ...MPP_REQUEST, methodDetails: { ...MPP_REQUEST.methodDetails, splits: [{ amount: '1', recipient: PAY_TO }] } })), 'unsupported_transfer_method');
    await rejects(pay(mppChallenge({ ...MPP_REQUEST, amount: '20000' })), 'price_above_limit', /0\.02 SBC exceeds maxPerRequest 0\.01 SBC/);
    await rejects(pay(mppChallenge(MPP_REQUEST, { method: 'tempo' })), 'no_compatible_offer', /tempo\/charge/);
  });

  it('pays an mppx seller settling through an x402 facilitator', async () => {
    const calls = mockFacilitator();
    const mppx = MppxServer.create({
      secretKey: SECRET,
      realm: 'seller.test',
      methods: [evmServer.charge({ currency: SBC.address, chainId: 72344, decimals: 6, authorization: { name: 'Stable Coin', version: '1' }, recipient: PAY_TO, x402: { facilitator: FACILITATOR } })],
    });
    const mppxSeller = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = await mppx.charge({ amount: '0.001' })(new Request(input, init));
      return result.status === 402 ? result.challenge : result.withReceipt(Response.json({ ok: true }));
    }) as typeof globalThis.fetch;
    let paid: PaymentReceipt | undefined;
    const { payFetch, offers } = buyer(mppxSeller, { protocols: ['mpp'], onPaid: (r) => void (paid = r) });
    const res = await payFetch(URL_);
    expect(res.status).toBe(200);
    expect(offers[0].protocol).toBe('mpp');
    expect(paid).toMatchObject({ protocol: 'mpp', transaction: TX });
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
  });
});

// -- server --------------------------------------------------------------------------------------

function mppSeller(extra: Partial<Parameters<typeof radiusPayments>[0]> = {}) {
  const settled: PaymentReceipt[] = [];
  const pay = radiusPayments({
    network: 'testnet',
    facilitator: { live: false },
    payTo: PAY_TO,
    routes: { 'GET /api/lookup': { price: '$0.001', description: 'Lookup' }, 'GET /api/other': '$0.002' },
    mpp: { secretKey: SECRET },
    onSettled: (r) => void settled.push(r),
    ...extra,
  });
  const app = pay.wrap((_request, payment) => Response.json({ data: 'secret', payment }));
  return { app, settled, fetch: ((input: RequestInfo | URL, init?: RequestInit) => app(new Request(input, init))) as typeof globalThis.fetch };
}

describe('radiusPayments with MPP', () => {
  it('offers an MPP challenge next to the x402 offers, verifiable by mppx', async () => {
    const res = await mppSeller().app(new Request(URL_));
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    const [c] = Challenge.deserializeList(res.headers.get('www-authenticate')!);
    expect(c).toMatchObject({ realm: 'seller.test', method: 'evm', intent: 'charge', description: 'Lookup', request: { amount: '1000', currency: SBC.address, recipient: PAY_TO, methodDetails: { chainId: 72344, credentialTypes: ['authorization'], decimals: 6 } } });
    expect(Challenge.verify(c, { secretKey: SECRET })).toBe(true);
    expect(Date.parse(c.expires!) - Date.now()).toBeGreaterThan(290_000);
  });

  it('one challenge per network', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }));
    const res = await mppSeller({ network: undefined, facilitator: undefined, networks: [{ network: 'testnet', facilitator: { live: false } }, 'base-sepolia'] }).app(new Request(URL_));
    const challenges = Challenge.deserializeList(res.headers.get('www-authenticate')!);
    expect(challenges.map((c) => (c.request as { methodDetails: { chainId: number } }).methodDetails.chainId)).toEqual([72344, 84532]);
  });

  it('settles an MPP payment through the facilitator as an x402 EIP-3009 payload, before the handler', async () => {
    const calls = mockFacilitator();
    const s = mppSeller();
    const { payFetch, offers } = buyer(s.fetch, { protocols: ['mpp'] });
    const res = await payFetch(URL_);
    expect(res.status).toBe(200);
    expect(offers[0].protocol).toBe('mpp');
    expect(Receipt.fromResponse(res)).toMatchObject({ method: 'evm', reference: TX, status: 'success' });
    expect(res.headers.get('cache-control')).toContain('private');
    expect((await res.json()).payment).toMatchObject({ success: true, protocol: 'mpp', transaction: TX, network: 'eip155:72344', amount: '1000' });
    expect(s.settled).toEqual([expect.objectContaining({ protocol: 'mpp', transaction: TX })]);
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
    const { paymentPayload, paymentRequirements } = calls[1].body;
    // Exactly the route's x402 offer, extras included.
    expect(paymentRequirements).toMatchObject({ scheme: 'exact', network: 'eip155:72344', asset: SBC.address, amount: '1000', payTo: PAY_TO, extra: { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1', paymentFlow: 'upfront' } });
    expect(paymentPayload.accepted).toEqual(paymentRequirements);
    expect(paymentPayload.payload.authorization).toMatchObject({ from: SIGNER.address, to: PAY_TO, value: '1000', validAfter: '0' });
  });

  it('offers no MPP challenge where the facilitator settles by Permit2 only', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } }], extensions: [], signers: {} }),
    );
    const res = await mppSeller({ facilitator: undefined }).app(new Request(URL_));
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('runs every onSettled listener even when one throws', async () => {
    mockFacilitator();
    const seen: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pay = radiusPayments({ network: 'testnet', facilitator: { live: false }, payTo: PAY_TO, routes: { 'GET /api/lookup': '$0.001' }, mpp: { secretKey: SECRET } });
    pay.radius.onSettled(() => { throw new Error('analytics down'); }).onSettled((r) => void seen.push(r.protocol!));
    const f = ((i: RequestInfo | URL, init?: RequestInit) => pay.wrap(() => Response.json({}))(new Request(i, init))) as typeof globalThis.fetch;
    await buyer(f, { protocols: ['mpp'] }).payFetch(URL_);
    await buyer(f, { protocols: ['x402'] }).payFetch(URL_);
    expect(seen).toEqual(['mpp', 'x402']);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('settle "after" runs the handler first and charges nothing when it fails', async () => {
    const calls = mockFacilitator();
    const pay = radiusPayments({ network: 'testnet', facilitator: { live: false }, payTo: PAY_TO, routes: { 'GET /api/*': '$0.001' }, mpp: { secretKey: SECRET }, settle: 'after' });
    const app = pay.wrap((req, payment) => (req.url.endsWith('/fail') ? Response.json({ error: 'nope' }, { status: 500 }) : Response.json({ payment })));
    const f = ((i: RequestInfo | URL, init?: RequestInit) => app(new Request(i, init))) as typeof globalThis.fetch;
    const ok = await buyer(f, { protocols: ['mpp'] }).payFetch('http://seller.test/api/x');
    expect(ok.status).toBe(200);
    expect((await ok.json()).payment).toBeUndefined();
    expect(Receipt.fromResponse(ok).reference).toBe(TX);
    const failed = await buyer(f, { protocols: ['mpp'] }).payFetch('http://seller.test/api/fail');
    expect(failed.status).toBe(500);
    expect(failed.headers.get('payment-receipt')).toBeNull();
    expect(calls.filter((c) => c.url.endsWith('/settle'))).toHaveLength(1);
  });

  it('is paid by the mppx client', async () => {
    const calls = mockFacilitator();
    const s = mppSeller();
    const mppx = MppxClient.create({
      polyfill: false,
      fetch: s.fetch,
      methods: [evmClient.charge({ account: SIGNER, authorization: { name: 'Stable Coin', version: '1' }, decimals: 6, maxAmount: '0.01', networks: [72344] })],
      orderChallenges: (candidates: { challenge: { id: string } }[]) => candidates.filter((c) => !String(c.challenge.id).startsWith('x402:')),
    } as never);
    const res = await mppx.fetch(URL_);
    expect(res.status).toBe(200);
    expect(Receipt.fromResponse(res).reference).toBe(TX);
    expect(s.settled).toEqual([expect.objectContaining({ protocol: 'mpp' })]);
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
  });

  describe('rejects credentials before calling the facilitator', () => {
    /** A valid credential for `url`, then `tamper` it. */
    async function attempt(tamper: (cred: { challenge: Record<string, unknown>; payload: Record<string, unknown> }) => void, url = URL_, target = url) {
      const calls = mockFacilitator();
      const s = mppSeller();
      let credentialHeader = '';
      const capture = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const auth = req.headers.get('authorization');
        if (auth) {
          credentialHeader = auth;
          return Response.json({});
        }
        return s.fetch(req);
      }) as typeof globalThis.fetch;
      await buyer(capture, { protocols: ['mpp'] }).payFetch(url);
      const wire = JSON.parse(Buffer.from(credentialHeader.slice('Payment '.length), 'base64url').toString());
      tamper(wire);
      const res = await s.app(new Request(target, { headers: { Authorization: `Payment ${Buffer.from(JSON.stringify(wire)).toString('base64url')}` } }));
      return { res, calls, settled: s.settled };
    }

    it.each([
      ['a changed price', (w: any) => (w.challenge.request = Buffer.from(JSON.stringify({ ...MPP_REQUEST, amount: '1' })).toString('base64url')), /not issued by this server/],
      ['another realm', (w: any) => (w.challenge.realm = 'evil.test'), /not issued by this server/],
      ['an unbound nonce', (w: any) => (w.payload.nonce = `0x${'11'.repeat(32)}`), /not bound to this challenge/],
      ['a different recipient', (w: any) => (w.payload.to = '0x1111111111111111111111111111111111111111'), /recipient mismatch/],
      ['a different amount', (w: any) => (w.payload.value = '1'), /amount mismatch/],
      ['an expired authorization', (w: any) => (w.payload.validBefore = '1'), /expired/],
      ['a mismatched source', (w: any) => (w.source = 'did:pkh:eip155:72344:0x1111111111111111111111111111111111111111'), /source/],
    ])('%s', async (_name, tamper, reason) => {
      const { res, calls, settled } = await attempt(tamper);
      expect(res.status).toBe(402);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect((await res.json()).detail).toMatch(reason);
      expect(Challenge.deserializeList(res.headers.get('www-authenticate')!)).toHaveLength(1);
      expect(res.headers.get('payment-required')).toBeTruthy();
      expect(calls).toHaveLength(0);
      expect(settled).toHaveLength(0);
    });

    it("a credential for another route's price", async () => {
      const { res, calls } = await attempt(() => {}, URL_, 'http://seller.test/api/other');
      expect(res.status).toBe(402);
      expect((await res.json()).detail).toMatch(/does not match this route's price/);
      expect(calls).toHaveLength(0);
    });
  });

  it("answers 402 with the facilitator's reason when it rejects the authorization", async () => {
    mockFacilitator({ valid: false });
    await rejects(buyer(mppSeller().fetch, { protocols: ['mpp'] }).payFetch(URL_), 'payment_rejected');
  });

  it('requires a long secret', () => {
    expect(() => radiusPayments({ network: 'testnet', payTo: PAY_TO, routes: {}, mpp: { secretKey: 'short' } })).toThrow(/at least 32 characters/);
  });
});
