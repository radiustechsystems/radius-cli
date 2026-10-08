import type { HTTPAdapter, HTTPRequestContext } from '@x402/core/server';

/**
 * x402 `HTTPAdapter` over a web-standard `Request`. Works anywhere `Request`/`Response`
 * exist: Cloudflare Workers, Bun, Deno, Node 22+, Next.js route handlers, and
 * frameworks built on them (Hono, SvelteKit, Remix, Astro).
 */
export class RequestAdapter implements HTTPAdapter {
  readonly url: URL;

  constructor(readonly request: Request) {
    this.url = new URL(request.url);
  }

  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }
  getMethod(): string {
    return this.request.method;
  }
  getPath(): string {
    return this.url.pathname;
  }
  getUrl(): string {
    return this.request.url;
  }
  getAcceptHeader(): string {
    return this.request.headers.get('accept') ?? '';
  }
  getUserAgent(): string {
    return this.request.headers.get('user-agent') ?? '';
  }
  getQueryParams(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of this.url.searchParams) {
      const existing = out[key];
      if (existing === undefined) out[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else out[key] = [existing, value];
    }
    return out;
  }
  getQueryParam(name: string): string | string[] | undefined {
    const all = this.url.searchParams.getAll(name);
    if (all.length === 0) return undefined;
    return all.length === 1 ? all[0] : all;
  }
  async getBody(): Promise<unknown> {
    try {
      return await this.request.clone().json();
    } catch {
      return undefined;
    }
  }
}

function decodePath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

/** Build the x402 request context for a web-standard `Request`. */
export function requestContext(request: Request): HTTPRequestContext {
  const adapter = new RequestAdapter(request);
  return {
    adapter,
    path: adapter.getPath(),
    decodedPath: decodePath(adapter.getPath()),
    method: request.method,
    paymentHeader: adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment'),
  };
}

/**
 * The `Request` behind an x402 request context, when it was produced by this SDK's
 * adapter (the web-standard handler and the Hono middleware). `undefined` for
 * requests served through a third-party adapter such as `@x402/express`.
 */
export function requestOf(context: HTTPRequestContext | undefined): Request | undefined {
  const adapter = context?.adapter;
  return adapter instanceof RequestAdapter ? adapter.request : undefined;
}
