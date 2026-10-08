// Worker entry for the docs site. Static assets (dist/public) are served by Workers static assets;
// only /api/try/* reaches this code (`assets.run_worker_first` in wrangler.jsonc): the backend for the
// interactive "Try Radius" components, a testnet seller and a faucet proxy.
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';
import { radiusTestnet } from 'radius-sdk';
import { TRY_ROUTES as ROUTES } from '../docs/components/try/routes';

type Env = {
  Bindings: { TRY_PAY_TO: `0x${string}` };
  Variables: RadiusPaymentVariables;
};

const FAUCET_URL = radiusTestnet.faucetUrl as string;

const app = new Hono<Env>();

app.get('/api/try/info', (c) =>
  c.json({
    network: radiusTestnet.name,
    caip2: radiusTestnet.network,
    payTo: c.env.TRY_PAY_TO,
    routes: Object.entries(ROUTES).map(([route, spec]) => ({ route, ...spec })),
  }),
);

// The faucet API sends no CORS headers, so the browser calls it through this same-origin proxy.
// The components pass `faucetUrl: <origin>/api/try/faucet` to radius-sdk, so fund() works unchanged.
app.on(['GET', 'POST'], '/api/try/faucet/*', async (c) => {
  const upstream = new URL(FAUCET_URL + c.req.path.slice('/api/try/faucet'.length));
  upstream.search = new URL(c.req.url).search;
  const res = await fetch(upstream, {
    method: c.req.method,
    headers: { accept: 'application/json', ...(c.req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: c.req.method === 'POST' ? await c.req.text() : undefined,
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
});

app.use(
  '/api/try/*',
  radiusPayments<Env>({
    network: 'testnet',
    payTo: (c) => c.env.TRY_PAY_TO,
    routes: ROUTES,
  }),
);

app.get('/api/try/lookup', (c) => {
  const ip = c.req.query('ip') ?? '0.0.0.0';
  const payment = c.get('radiusPayment');
  return c.json({ ip, reputation: 'clean', score: 7, paidBy: payment?.payer, transaction: payment?.transaction });
});

app.get('/api/try/report', (c) => {
  const ip = c.req.query('ip') ?? '0.0.0.0';
  const payment = c.get('radiusPayment');
  return c.json({
    ip,
    reputation: 'clean',
    score: 7,
    asn: 'AS64500',
    firstSeen: '2026-01-14',
    reports: [],
    paidBy: payment?.payer,
    transaction: payment?.transaction,
  });
});

app.notFound((c) => c.json({ error: 'not found' }, 404));

export default app;
