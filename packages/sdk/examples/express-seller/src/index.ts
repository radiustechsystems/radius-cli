// A paid API on Express using the upstream x402 adapter. The SDK supplies the Radius
// resource server (facilitator, SBC pricing, gas sponsoring); `@x402/express` supplies
// the middleware. `@x402/next` and `@x402/hono` take the same two arguments.
import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { createRadiusServer } from 'radius-sdk/server';

const PAY_TO = (process.env.PAY_TO ?? '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE') as `0x${string}`;
const NETWORK = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const PORT = Number(process.env.PORT ?? 8789);

const radius = createRadiusServer({
  network: NETWORK,
  onSettled: (receipt) => console.log('settled', receipt.transaction, receipt.payer),
});

const app = express();
app.get('/', (_req, res) => {
  res.json({ ok: true, paid: ['GET /api/lookup?ip=…  $0.001', 'POST /api/query  $0.01'] });
});

app.use(
  paymentMiddleware(
    radius.routes({
      payTo: PAY_TO,
      routes: {
        'GET /api/lookup': { price: '$0.001', description: 'Synthetic threat-intel lookup for one IP' },
        'POST /api/query': { price: '$0.01', description: 'Batch query' },
      },
    }),
    radius.server,
  ),
);

// Handlers only run after the payment has settled on Radius (the SDK defaults to settling first).
app.get('/api/lookup', (req, res) => {
  const ip = typeof req.query.ip === 'string' ? req.query.ip : '0.0.0.0';
  res.json({ ip, reputation: ip.startsWith('10.') ? 'private' : 'clean', score: 7 });
});
app.post('/api/query', express.json(), (req, res) => {
  res.json({ received: req.body ?? {}, results: [] });
});

app.listen(PORT, () => console.log(`radius-express-seller on http://localhost:${PORT} (${NETWORK}, pay to ${PAY_TO})`));
