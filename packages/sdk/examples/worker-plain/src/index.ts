// A paid API on Cloudflare Workers with no framework: the SDK's web-standard handler
// takes a `Request` and returns a `Response`. The same code runs on Bun, Deno, Node 18+
// (`Bun.serve({ fetch })`, `Deno.serve(fetch)`) and in Next.js / SvelteKit route handlers.
import { radiusPayments, type PaymentHandler } from 'radius-sdk/server';

type Env = { PAY_TO: `0x${string}`; RADIUS_NETWORK: 'mainnet' | 'testnet' };

let pay: PaymentHandler | undefined;

// Built on the first request so config can come from bindings (Workers forbid I/O at
// module scope; the handler does none, but env is only available per request).
function payments(env: Env): PaymentHandler {
  return (pay ??= radiusPayments({
    network: env.RADIUS_NETWORK,
    payTo: env.PAY_TO,
    routes: {
      'GET /api/lookup': { price: '$0.001', description: 'Synthetic threat-intel lookup for one IP' },
      'POST /api/query': { price: '$0.01', description: 'Batch query' },
    },
    onSettled: (receipt, request) => console.log('settled', receipt.transaction, receipt.payer, new URL(request.url).pathname),
  }));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // `payment` is the settled receipt: handlers only run for money already received.
    return payments(env)(request, async (request, payment) => {
      const url = new URL(request.url);
      if (url.pathname === '/') return Response.json({ ok: true, paid: ['GET /api/lookup?ip=…  $0.001', 'POST /api/query  $0.01'] });
      if (url.pathname === '/api/lookup') {
        const ip = url.searchParams.get('ip') ?? '0.0.0.0';
        return Response.json({ ip, reputation: ip.startsWith('10.') ? 'private' : 'clean', score: 7, paidBy: payment?.payer, tx: payment?.transaction });
      }
      if (url.pathname === '/api/query' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return Response.json({ received: body, results: [] });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
  },
};
