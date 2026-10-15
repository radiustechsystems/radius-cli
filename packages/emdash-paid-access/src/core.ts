import { radiusPayments, type PaymentHandler, type RadiusServerOptions } from 'radius-sdk/server';
import type { Address, Price } from 'radius-sdk';
import type { PaymentReceipt } from 'radius-sdk';

export type { Price };

export interface PaidAccessOptions extends Pick<RadiusServerOptions, 'network' | 'networks' | 'facilitator' | 'settle' | 'mpp'> {
  /** Wallet that receives every payment. */
  payTo: Address;
  /** Price when a request does not name one. Default "$0.01". */
  defaultPrice?: Price;
  /** Description shown in the 402 and in agent wallets. */
  description?: string;
  /**
   * Only charge requests Cloudflare Bot Management scores below `botScoreThreshold`. Fails open:
   * with no bot score (local dev, a non-Cloudflare host, Bot Management off) every request is
   * treated as human and passes free. Leave off when a missing score must not mean free access.
   */
  botOnly?: boolean;
  /** Scores below this are bots (1-99, lower is more likely a bot). Default 30. */
  botScoreThreshold?: number;
  /** Called once per settled payment. Runs before the page renders (the default `settle: 'before'`). */
  onSettled?: (receipt: PaymentReceipt, request: Request) => void | Promise<void>;
}

export interface EnforceOptions {
  /** Price for this request. Defaults to `defaultPrice`. */
  price?: Price;
}

/** The request may proceed: it paid, or it was exempt. */
export interface EnforceResult {
  /** A payment was verified and settled for this request. */
  paid: boolean;
  /** The request was exempt (not a GET, or a human under `botOnly`), so nothing was charged. */
  skipped: boolean;
  payer?: string;
  receipt?: PaymentReceipt;
  /** Settlement headers (`PAYMENT-RESPONSE`, private `Cache-Control`) to send with the paid response. */
  headers: Headers;
}

export interface PaidAccess {
  /**
   * Charge for `request`. Returns a 402 `Response` to send back when it carries no valid payment,
   * or an `EnforceResult` once it paid or is exempt.
   *
   * With the default `settle: 'before'` funds move before this returns, so look the content up
   * first and call `enforce` only for a page that exists; an unknown slug stays a free 404.
   */
  enforce(request: Request, options?: EnforceOptions): Promise<Response | EnforceResult>;
  /** True when the request carries a payment header. It proves nothing: use `enforce` before returning paid content. */
  hasPayment(request: Request): boolean;
  /** Copy settlement headers onto the response you are about to send (`Astro.response` or a `Headers`). */
  applyHeaders(result: EnforceResult, target: { headers: Headers } | Headers): void;
  /** The underlying handler, for access to the `RadiusServer`. */
  readonly handler: PaymentHandler;
}

interface CloudflareRequest extends Request {
  cf?: { botManagement?: { score?: number } };
}

const PAYMENT_HEADERS = ['payment-signature', 'x-payment'];

function isBot(request: Request, threshold: number): boolean {
  const score = (request as CloudflareRequest).cf?.botManagement?.score;
  return typeof score === 'number' && score < threshold;
}

export function createPaidAccess(options: PaidAccessOptions): PaidAccess {
  const { payTo, defaultPrice = '$0.01', description, botOnly = false, botScoreThreshold = 30, onSettled, ...serverOptions } = options;
  if (!Number.isFinite(botScoreThreshold)) throw new Error('radius-emdash-paid-access: botScoreThreshold must be a number');

  // The route is a catch-all; `enforce` is only called for pages you want paid. The price rides on
  // the Request itself so one handler (one facilitator handshake) serves every price.
  const prices = new WeakMap<Request, Price>();
  const handler = radiusPayments({
    ...serverOptions,
    payTo,
    routes: {
      'GET /*': {
        price: (request) => prices.get(request) ?? defaultPrice,
        description,
      },
    },
    onSettled,
  });

  const exempt = (): EnforceResult => ({ paid: false, skipped: true, headers: new Headers() });

  return {
    handler,
    hasPayment: (request) => PAYMENT_HEADERS.some((h) => request.headers.has(h)),
    async enforce(request, enforceOptions = {}) {
      if (request.method !== 'GET') return exempt();
      if (botOnly && !isBot(request, botScoreThreshold)) return exempt();
      prices.set(request, enforceOptions.price ?? defaultPrice);

      let receipt: PaymentReceipt | undefined;
      let reached = false;
      const response = await handler(request, (_request, payment) => {
        reached = true;
        receipt = payment;
        return new Response(null, { status: 204 });
      });
      if (!reached) return response;
      return { paid: true, skipped: false, payer: receipt?.payer, receipt, headers: response.headers };
    },
    applyHeaders(result, target) {
      const headers = target instanceof Headers ? target : target.headers;
      result.headers.forEach((value, key) => headers.set(key, value));
    },
  };
}

/** Whether `pathname` matches a route pattern: exact, or `*` for any run of characters ("/posts/*"). */
export function matchesPath(pattern: string, pathname: string): boolean {
  if (!pattern.includes('*')) return pattern === pathname || pattern.replace(/\/$/, '') === pathname.replace(/\/$/, '');
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(pathname);
}
