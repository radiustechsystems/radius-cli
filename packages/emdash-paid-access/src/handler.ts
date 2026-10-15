import { matchesPath, type PaidAccess, type PaidAccessOptions } from './core.js';

/** The configuration `radiusPaidAccess()` hands the middleware: the JSON-safe subset of the options. */
export interface MiddlewareConfig extends Omit<PaidAccessOptions, 'facilitator' | 'onSettled' | 'mpp' | 'networks' | 'settle'> {
  /** Path patterns charged automatically, each with an optional price. */
  routes: Record<string, string | number | null>;
}

export interface MiddlewareContext {
  request: Request;
  url: URL;
  locals: Record<string, unknown>;
}

export type Next = () => Promise<Response>;

/** Charge matching routes before the page renders, and expose `locals.radiusPaidAccess` for pages that price themselves. */
export function createMiddleware(getAccess: () => PaidAccess, settings: Pick<MiddlewareConfig, 'routes'>) {
  const patterns = Object.entries(settings.routes);
  return async (context: MiddlewareContext, next: Next): Promise<Response> => {
    const access = getAccess();
    context.locals.radiusPaidAccess = access;

    const { pathname } = context.url;
    const match = patterns.find(([pattern]) => matchesPath(pattern, pathname));
    if (!match) return next();

    const price = match[1] ?? undefined;
    const result = await access.enforce(context.request, price === undefined ? {} : { price });
    if (result instanceof Response) return result;

    const response = await next();
    if (!result.paid) return response;
    // `next()` can return a response with immutable headers, so copy before adding the receipt.
    const out = new Response(response.body, response);
    access.applyHeaders(result, out);
    return out;
  };
}
