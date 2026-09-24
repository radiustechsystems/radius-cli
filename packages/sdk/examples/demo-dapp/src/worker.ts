// Seller side of the demo: a Hono worker with a few priced endpoints.
// The page at / (static asset) is the buyer side.
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';
import { resolveNetwork } from 'radius-sdk';

type Env = {
  Bindings: { PAY_TO: `0x${string}`; RADIUS_NETWORK: 'mainnet' | 'testnet' };
  Variables: RadiusPaymentVariables;
};

const PRICES = {
  'GET /api/quote': { price: '$0.001', description: 'A quote of the moment' },
  'GET /api/lookup': { price: '$0.001', description: 'Synthetic threat-intel lookup for ?ip=' },
  'POST /api/echo': { price: '$0.01', description: 'Echo a JSON body back' },
  'GET /api/premium': { price: '$5', description: 'Deliberately expensive: exercises the client cap' },
} as const;

const QUOTES = [
  'The best way to predict the future is to invent it.',
  'Simplicity is prerequisite for reliability.',
  'Make it work, make it right, make it fast.',
  'A payment is a message that someone believed you.',
];

const app = new Hono<Env>();

// Free: describes the seller so the page can render the endpoint list.
app.get('/api/info', (c) => {
  const network = resolveNetwork(c.env.RADIUS_NETWORK ?? 'testnet');
  return c.json({
    network: network.name,
    caip2: network.network,
    payTo: c.env.PAY_TO,
    asset: network.asset,
    routes: Object.entries(PRICES).map(([route, p]) => ({ route, ...p })),
  });
});

// The Radius faucet API sends no CORS headers, so browsers cannot call it directly.
// Same-origin proxy for the three faucet endpoints (GET /status/:address, GET /challenge/:address,
// POST /drip): the page passes `faucetUrl: <origin>/faucet` and the SDK's faucet client works
// unchanged. Errors use the Radius API envelope (`{ error: { code, message, request_id } }`) so the
// client maps them too.
const apiError = (code: string, message: string) => ({ error: { code, message, request_id: `req_${crypto.randomUUID()}` } });
app.all('/faucet/*', async (c) => {
  const network = resolveNetwork(c.env.RADIUS_NETWORK ?? 'testnet');
  if (!network.faucetUrl) return c.json(apiError('no_faucet', `no faucet for ${network.name}`), 404);
  const path = c.req.path.slice('/faucet'.length);
  const allowed = (c.req.method === 'GET' && /^\/(status|challenge)\/0x[0-9a-fA-F]{40}$/.test(path)) || (c.req.method === 'POST' && path === '/drip');
  if (!allowed) return c.json(apiError('not_found', `unknown faucet endpoint ${c.req.method} ${path}`), 404);
  const upstream = network.faucetUrl + path + (new URL(c.req.url).search || '');
  const init: RequestInit = { method: c.req.method, headers: { accept: 'application/json' } };
  if (c.req.method === 'POST') { init.body = await c.req.text(); init.headers = { ...init.headers, 'content-type': 'application/json' }; }
  const res = await fetch(upstream, init);
  const headers: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/json' };
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(await res.text(), { status: res.status, headers });
});

app.use(
  '/api/*',
  radiusPayments<Env>({
    network: 'testnet',
    payTo: (c) => c.env.PAY_TO,
    routes: PRICES,
    onSettled: (r) => console.log(`settled ${r.amount} from ${r.payer}: ${r.transaction}`),
  }),
);

app.get('/api/quote', (c) => {
  const p = c.get('radiusPayment');
  return c.json({ quote: QUOTES[Math.floor(Math.random() * QUOTES.length)], at: new Date().toISOString(), paidBy: p?.payer, tx: p?.transaction });
});
app.get('/api/lookup', (c) => {
  const ip = c.req.query('ip') ?? '0.0.0.0';
  return c.json({ ip, reputation: ip.startsWith('10.') ? 'private' : 'clean', score: 7, tx: c.get('radiusPayment')?.transaction });
});
app.post('/api/echo', async (c) => c.json({ echo: await c.req.json().catch(() => null), tx: c.get('radiusPayment')?.transaction }));
app.get('/api/premium', (c) => c.json({ premium: 'you paid $5 for this', tx: c.get('radiusPayment')?.transaction }));

export default app;
