// Validate, then pay: with the default `settle: 'before'`, funds move before the paid handler
// runs, so a lookup that can fail belongs before `pay()`. A missing article is an unpaid 404;
// a real one is charged, then delivered.
import type { APIRoute } from 'astro';
import { loadArticle } from '../../lib/articles';
import { pay } from '../../lib/payments';

export const GET: APIRoute = async ({ request, params }) => {
  const article = await loadArticle(params.slug);
  if (!article) return new Response('Not found', { status: 404 });
  return pay(request, (_request, payment) => Response.json({ ...article, paidBy: payment?.payer, tx: payment?.transaction }));
};
