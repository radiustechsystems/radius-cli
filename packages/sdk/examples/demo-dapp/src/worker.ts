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
  const name = c.env.RADIUS_NETWORK ?? 'testnet';
  const network = resolveNetwork(name);
  return c.json({
    // The page's network picker uses the 'mainnet' / 'testnet' aliases.
    network: name,
    caip2: network.network,
    payTo: c.env.PAY_TO,
    asset: network.asset,
    routes: Object.entries(PRICES).map(([route, p]) => ({ route, ...p })),
  });
});

// The Radius faucet API sends no CORS headers, so browsers cannot call it directly.
// Same-origin proxy: the page sets `faucetUrl: <origin>/faucet` and the SDK's fund() works unchanged.
app.all('/faucet/*', async (c) => {
  const network = resolveNetwork(c.env.RADIUS_NETWORK ?? 'testnet');
  if (!network.faucetUrl) return c.json({ error: { code: 'no_faucet', message: `no faucet for ${network.name}` } }, 404);
  const upstream = network.faucetUrl + c.req.path.slice('/faucet'.length) + (new URL(c.req.url).search || '');
  const init: RequestInit = { method: c.req.method, headers: { accept: 'application/json' } };
  if (c.req.method === 'POST') { init.body = await c.req.text(); init.headers = { ...init.headers, 'content-type': 'application/json' }; }
  const res = await fetch(upstream, init);
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
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
