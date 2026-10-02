import type { Context, Env, MiddlewareHandler } from 'hono';
import {
  FacilitatorResponseError,
  type FacilitatorClient,
  SETTLEMENT_OVERRIDES_HEADER,
  getFacilitatorResponseError,
  withPrivateCacheControl,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RouteConfig,
  type RoutesConfig,
} from '@x402/core/server';
import type { SettleResponse } from '@x402/core/types';
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from '../networks.js';
import { resolvePrice, type Price } from '../amounts.js';
import { explorerTxUrl } from '../networks.js';
import type { PaymentReceipt } from '../receipt.js';
import { RadiusFacilitatorClient, withUnknownOutcomes, type FacilitatorOptions } from './facilitator.js';
import { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';

export { RadiusFacilitatorClient, staticSupported, type FacilitatorOptions } from './facilitator.js';
export { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';

export type PayTo<E extends Env> = Address | ((c: Context<E>) => Address | Promise<Address>);

export interface RouteSpec<E extends Env = Env> {
  /** "$0.01", "0.01", 0.01 (USD == SBC), or { amount: "10000" } atomic units. */
  price: Price | ((c: Context<E>) => Price | Promise<Price>);
  description?: string;
  mimeType?: string;
  /** Seconds the signed payment stays valid. Default 300. */
  maxTimeoutSeconds?: number;
  /** Per-route recipient override. */
  payTo?: PayTo<E>;
}

export interface RadiusPaymentsOptions<E extends Env = Env> extends NetworkOverrides {
  /** 'mainnet' (default), 'testnet', a preset, or a custom instance. */
  network?: NetworkInput;
  /** Recipient of every payment (unless a route overrides it). May read `c.env`. */
  payTo: PayTo<E>;
  /**
   * Protected routes keyed "METHOD /path" (Hono-style `*` wildcards allowed, e.g.
   * "GET /api/*"). A bare price is shorthand for `{ price }`.
   */
  routes: Record<string, RouteSpec<E> | Price>;
  /**
   * Which facilitator verifies and settles. Defaults to the Radius facilitator for
   * the network. Pass `{ url, apiKey }` for another hosted facilitator, or your own
   * `FacilitatorClient` (from `@x402/core/server`) for a self-hosted one.
   */
  facilitator?: FacilitatorOptions | FacilitatorClient;
  /**
   * 'before' (default): verify and settle on-chain, then run the handler — the
   * handler only ever runs for money already received.
   * 'after': verify, run the handler, settle if it succeeded (x402 default flow).
   */
  settle?: SettleMode;
  /**
   * Whether 402s declare `eip2612GasSponsoring` (lets first-time wallets pay without an
   * approval transaction). 'auto' (default): only when the facilitator supports it.
   */
  gasSponsoring?: GasSponsoringMode;
  /** Called once per settled payment. */
  onSettled?: (receipt: PaymentReceipt, c: Context<E>) => void | Promise<void>;
}

/** Hono context variable set for paid requests: `c.get('radiusPayment')`. */
export type RadiusPaymentVariables = { radiusPayment?: PaymentReceipt };

/** Adapter over Hono's context that also carries the context for dynamic payTo/price. */
export class RadiusHonoAdapter<E extends Env> implements HTTPAdapter {
  constructor(readonly c: Context<E>) {}
  getHeader(name: string): string | undefined {
    return this.c.req.header(name);
  }
  getMethod(): string {
    return this.c.req.method;
  }
  getPath(): string {
    return this.c.req.path;
  }
  getUrl(): string {
    return this.c.req.url;
  }
  getAcceptHeader(): string {
    return this.c.req.header('accept') ?? '';
  }
  getUserAgent(): string {
    return this.c.req.header('user-agent') ?? '';
  }
  getQueryParams(): Record<string, string | string[]> {
    return this.c.req.queries() as Record<string, string | string[]>;
  }
  getQueryParam(name: string): string | string[] | undefined {
    const all = this.c.req.queries(name);
    if (!all || all.length === 0) return undefined;
    return all.length === 1 ? all[0] : all;
  }
  async getBody(): Promise<unknown> {
    try {
      return await this.c.req.raw.clone().json();
    } catch {
      return undefined;
    }
  }
}

const GAS_SPONSORING_DECLARATION = {
  eip2612GasSponsoring: {
    info: {
      description: 'The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.',
      version: '1',
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        asset: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        spender: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        amount: { type: 'string', pattern: '^[0-9]+$' },
        nonce: { type: 'string', pattern: '^[0-9]+$' },
        deadline: { type: 'string', pattern: '^[0-9]+$' },
        signature: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' },
        version: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' },
      },
      required: ['from', 'asset', 'spender', 'amount', 'nonce', 'deadline', 'signature', 'version'],
    },
  },
} as const;

function isFacilitatorClient(v: unknown): v is FacilitatorClient {
  return typeof v === 'object' && v !== null && typeof (v as FacilitatorClient).settle === 'function' && typeof (v as FacilitatorClient).getSupported === 'function';
}

function contextOf<E extends Env>(ctx: HTTPRequestContext): Context<E> {
  const adapter = ctx.adapter as RadiusHonoAdapter<E>;
  if (!adapter.c) throw new Error('radius-sdk: expected RadiusHonoAdapter');
  return adapter.c;
}

function toReceipt(r: SettleResponse, network: RadiusNetwork, requirements: { amount: string }): PaymentReceipt {
  const transaction = r.transaction && r.transaction.length > 0 ? r.transaction : undefined;
  return {
    success: r.success,
    transaction,
    network: r.network,
    payer: r.payer,
    // `exact` settles precisely the requested amount; facilitators only report `amount`
    // for schemes (like `upto`) where it can differ.
    amount: r.amount ?? (r.success ? requirements.amount : undefined),
    errorReason: r.errorReason,
    errorMessage: r.errorMessage,
    explorerUrl: transaction ? explorerTxUrl(network, transaction) : undefined,
  };
}

function applyInstructions<E extends Env>(c: Context<E>, r: HTTPResponseInstructions): Response {
  for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
  if (r.isHtml) return c.html(String(r.body ?? ''), r.status as 402);
  return c.json((r.body ?? {}) as object, r.status as 402);
}

function facilitatorErrorResponse<E extends Env>(c: Context<E>, error: FacilitatorResponseError): Response {
  return c.json({ error: 'facilitator_error', message: error.message }, 502);
}

function internalErrorResponse<E extends Env>(c: Context<E>, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: 'payment_processing_error', message }, 500);
}

/**
 * Hono middleware that charges for routes with Radius x402 payments.
 *
 * Standard x402 v2 on the wire: unpaid requests get a 402 with a `PAYMENT-REQUIRED`
 * header; paid requests carry `PAYMENT-SIGNATURE`, are verified and settled through
 * the Radius facilitator, and get a `PAYMENT-RESPONSE` header back.
 */
export function radiusPayments<E extends Env = Env>(options: RadiusPaymentsOptions<E>): MiddlewareHandler<E> {
  const network = resolveNetwork(options.network, options);
  const settle: SettleMode = options.settle ?? 'before';
  const facilitator = withUnknownOutcomes(
    isFacilitatorClient(options.facilitator) ? options.facilitator : new RadiusFacilitatorClient(network, options.facilitator),
  );
  const resourceServer = new x402ResourceServer(facilitator).register(network.network, new RadiusExactScheme(network, settle, options.gasSponsoring ?? 'auto'));

  const resolvePayTo = (spec: PayTo<E>) =>
    typeof spec === 'function' ? (ctx: HTTPRequestContext) => spec(contextOf<E>(ctx)) : spec;

  const routes: RoutesConfig = {};
  for (const [pattern, specOrPrice] of Object.entries(options.routes)) {
    const spec: RouteSpec<E> =
      typeof specOrPrice === 'object' && specOrPrice !== null && 'price' in specOrPrice
        ? (specOrPrice as RouteSpec<E>)
        : { price: specOrPrice as Price };
    const price = spec.price;
    const normalise = (p: Price) => resolvePrice(p, network.asset);
    const route: RouteConfig & { extensions?: Record<string, unknown> } = {
      accepts: {
        scheme: 'exact',
        network: network.network,
        payTo: resolvePayTo(spec.payTo ?? options.payTo),
        price: typeof price === 'function' ? async (ctx: HTTPRequestContext) => normalise(await price(contextOf<E>(ctx))) : normalise(price),
        maxTimeoutSeconds: spec.maxTimeoutSeconds ?? 300,
      },
      description: spec.description,
      mimeType: spec.mimeType,
      extensions: { ...GAS_SPONSORING_DECLARATION },
    };
    routes[pattern] = route;
  }

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // Lazy, request-time initialisation: Workers forbid I/O at module scope, and the
  // static facilitator answer means this is normally just bookkeeping anyway.
  let initPromise: Promise<void> | undefined;
  const ensureInitialized = () =>
    (initPromise ??= httpServer.initialize().catch((e) => {
      initPromise = undefined;
      throw e;
    }));

  return async (c, next) => {
    const adapter = new RadiusHonoAdapter<E>(c);
    const context: HTTPRequestContext = {
      adapter,
      path: c.req.path,
      method: c.req.method,
      paymentHeader: adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment'),
    };
    if (!httpServer.requiresPayment(context)) return next();

    try {
      await ensureInitialized();
    } catch (error) {
      const fe = getFacilitatorResponseError(error);
      return fe ? facilitatorErrorResponse(c, fe) : internalErrorResponse(c, error);
    }

    let result: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (error) {
      if (error instanceof FacilitatorResponseError) return facilitatorErrorResponse(c, error);
      return internalErrorResponse(c, error);
    }

    if (result.type === 'no-payment-required') return next();
    if (result.type === 'payment-error') return applyInstructions(c, result.response);

    const { cancellationDispatcher, beforeHandlerSettlement, paymentPayload, paymentRequirements, declaredExtensions } = result;
    let notified = false;
    const notify = async (r: SettleResponse) => {
      if (notified) return;
      notified = true;
      const receipt = toReceipt(r, network, paymentRequirements);
      c.set('radiusPayment' as never, receipt as never);
      if (options.onSettled) await options.onSettled(receipt, c);
    };
    if (beforeHandlerSettlement) await notify(beforeHandlerSettlement.result);

    try {
      await next();
    } catch (error) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_threw', error: error as Error });
      if (!beforeHandlerSettlement && !cancelSettlement) throw error;
      const res = internalErrorResponse(c, error);
      const headers = httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, res.headers.get('Cache-Control'));
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      c.res = res;
      return;
    }

    let res = c.res;
    if (res.status >= 400) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_failed', responseStatus: res.status });
      res.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
      const headers = httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, res.headers.get('Cache-Control'));
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return;
    }

    const responseBody = new Uint8Array(await res.clone().arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    c.res = undefined;
    try {
      const settleResult = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        { request: context, responseBody, responseHeaders },
        undefined,
        beforeHandlerSettlement,
      );
      if (!settleResult.success) {
        const r = settleResult.response;
        res = new Response(r.isHtml ? String(r.body ?? '') : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
      } else {
        for (const [k, v] of Object.entries(settleResult.headers)) res.headers.set(k, v);
        res.headers.set('Cache-Control', withPrivateCacheControl(res.headers.get('Cache-Control')));
        res.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
        await notify(settleResult);
      }
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        c.res = facilitatorErrorResponse(c, error);
        return;
      }
      console.error(error);
      res = c.json({ error: 'settlement_error' }, 402);
    }
    c.res = res;
  };
}
