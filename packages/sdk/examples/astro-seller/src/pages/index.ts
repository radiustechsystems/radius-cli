import type { APIRoute } from 'astro';

export const GET: APIRoute = () => Response.json({ ok: true, paid: ['GET /articles/hello-radius  $0.001'], unpaid404: 'GET /articles/missing' });
