import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createPaidAccess, matchesPath, type PaidAccessOptions } from '../src/core.js';
import { createMiddleware } from '../src/handler.js';

const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';

function make(options: Partial<PaidAccessOptions> = {}) {
  return createPaidAccess({ network: 'testnet', payTo: PAY_TO, facilitator: { live: false }, ...options });
}

afterEach(() => vi.restoreAllMocks());

/** Sign nothing: the mocked facilitator accepts any well-formed payload. */
function paymentFor(challenge: Response): string {
  const pr = decodePaymentRequiredHeader(challenge.headers.get('payment-required')!);
  const accepted = pr.accepts[0];
  const { paymentFlow: _flow, ...extra } = accepted.extra as Record<string, unknown>;
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: pr.resource,
    accepted: { ...accepted, extra },
    payload: { signature: '0xsig', permit2Authorization: {} },
  });
}

function mockFacilitator() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: '0xabc' });
    if (url.endsWith('/settle')) return Response.json({ success: true, transaction: '0xtx', network: 'eip155:72344', payer: '0xabc' });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const page = (path = '/posts/hello', init?: RequestInit) => new Request(`http://site.test${path}`, init);
const amountOf = (res: Response) => decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0].amount;

describe('enforce', () => {
  it('answers 402 with the default price when nothing is paid', async () => {
    const res = await make({ defaultPrice: '$0.01' }).enforce(page());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(402);
    expect(amountOf(res as Response)).toBe('10000');
  });

  it('prices each request on its own through one handler', async () => {
    const access = make({ defaultPrice: '$0.01' });
    expect(amountOf((await access.enforce(page('/a'), { price: '$0.05' })) as Response)).toBe('50000');
    expect(amountOf((await access.enforce(page('/b'), { price: '$0.002' })) as Response)).toBe('2000');
    expect(amountOf((await access.enforce(page('/c'))) as Response)).toBe('10000');
  });

  it('settles a paid request and returns its receipt and headers', async () => {
    const access = make();
    const challenge = (await access.enforce(page())) as Response;
    const calls = mockFacilitator();
    const result = await access.enforce(page('/posts/hello', { headers: { 'payment-signature': paymentFor(challenge) } }));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected a result');
    expect(result.paid).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.payer).toBe('0xabc');
    expect(result.receipt?.transaction).toBe('0xtx');
    expect(result.headers.get('payment-response')).toBeTruthy();
    expect(calls.some((c) => c.endsWith('/settle'))).toBe(true);

    const headers = new Headers();
    access.applyHeaders(result, { headers });
    expect(headers.get('payment-response')).toBe(result.headers.get('payment-response'));
  });

  it('lets non-GET requests through free', async () => {
    const result = await make().enforce(page('/posts/hello', { method: 'POST' }));
    expect(result).toMatchObject({ paid: false, skipped: true });
  });

  it('reports a payment header without trusting it', async () => {
    const access = make();
    expect(access.hasPayment(page())).toBe(false);
    expect(access.hasPayment(page('/', { headers: { 'payment-signature': 'junk' } }))).toBe(true);
    const forged = await access.enforce(page('/', { headers: { 'payment-signature': 'junk' } }));
    expect(forged).toBeInstanceOf(Response);
    expect((forged as Response).status).toBe(402);
  });
});

describe('botOnly', () => {
  const withScore = (score?: number) => {
    const request = page() as Request & { cf?: unknown };
    if (score !== undefined) request.cf = { botManagement: { score } };
    return request;
  };

  it('charges a low-scoring request', async () => {
    expect(((await make({ botOnly: true }).enforce(withScore(5))) as Response).status).toBe(402);
  });

  it('exempts a human score and, failing open, a missing one', async () => {
    const access = make({ botOnly: true, botScoreThreshold: 30 });
    expect(await access.enforce(withScore(80))).toMatchObject({ skipped: true });
    expect(await access.enforce(withScore())).toMatchObject({ skipped: true });
  });
});

describe('matchesPath', () => {
  it.each([
    ['/posts/*', '/posts/hello', true],
    ['/posts/*', '/posts/', true],
    ['/posts/*', '/pages/hello', false],
    ['/premium', '/premium', true],
    ['/premium', '/premium/', true],
    ['/premium', '/premium/a', false],
    ['*', '/anything/at/all', true],
    ['/a.b/*', '/aXb/c', false],
  ])('%s vs %s', (pattern, path, expected) => expect(matchesPath(pattern, path)).toBe(expected));
});

describe('middleware', () => {
  const context = (path: string, init?: RequestInit) => {
    const request = page(path, init);
    return { request, url: new URL(request.url), locals: {} as Record<string, unknown> };
  };

  it('exposes locals and passes unmatched paths through untouched', async () => {
    const access = make();
    const run = createMiddleware(() => access, { routes: { '/posts/*': null } });
    const ctx = context('/about');
    const res = await run(ctx, async () => new Response('free'));
    expect(await res.text()).toBe('free');
    expect(ctx.locals.radiusPaidAccess).toBe(access);
  });

  it('answers 402 on a matched path and never renders the page', async () => {
    const run = createMiddleware(() => make(), { routes: { '/posts/*': '$0.05' } });
    const next = vi.fn(async () => new Response('secret'));
    const res = await run(context('/posts/hello'), next);
    expect(res.status).toBe(402);
    expect(amountOf(res)).toBe('50000');
    expect(next).not.toHaveBeenCalled();
  });

  it('renders and adds the settlement header once paid', async () => {
    const access = make();
    const run = createMiddleware(() => access, { routes: { '/posts/*': null } });
    const challenge = await run(context('/posts/hello'), async () => new Response('secret'));
    mockFacilitator();
    const res = await run(context('/posts/hello', { headers: { 'payment-signature': paymentFor(challenge) } }), async () => new Response('secret'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret');
    expect(res.headers.get('payment-response')).toBeTruthy();
  });

  it('adds the header to a response whose headers are immutable', async () => {
    const access = make();
    const run = createMiddleware(() => access, { routes: { '*': null } });
    const challenge = await run(context('/x'), async () => new Response('secret'));
    mockFacilitator();
    const immutable = () => {
      const res = Response.redirect('http://site.test/y', 302);
      return res;
    };
    const res = await run(context('/x', { headers: { 'payment-signature': paymentFor(challenge) } }), async () => immutable());
    expect(res.status).toBe(302);
    expect(res.headers.get('payment-response')).toBeTruthy();
  });
});
