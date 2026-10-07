import {
  FacilitatorResponseError,
  type FacilitatorClient,
  SETTLEMENT_OVERRIDES_HEADER,
  getFacilitatorResponseError,
  withPrivateCacheControl,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RouteConfig,
  type RoutesConfig,
} from '@x402/core/server';
import type { SettleResponse } from '@x402/core/types';
import { resolveNetwork, explorerTxUrl, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from '../networks.js';
import { resolvePrice, type Price } from '../amounts.js';
import type { PaymentReceipt } from '../receipt.js';
import { RadiusFacilitatorClient, withUnknownOutcomes, type FacilitatorOptions } from './facilitator.js';
import { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';
import { requestContext, requestOf } from './adapter.js';

export { RadiusFacilitatorClient, staticSupported, withUnknownOutcomes, type FacilitatorOptions } from './facilitator.js';
export { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';
export { RequestAdapter, requestContext, requestOf } from './adapter.js';
export type { HTTPRequestContext, RoutesConfig, FacilitatorClient } from '@x402/core/server';

/** Recipient address, or a function of the request. */
export type PayTo<Ctx> = Address | ((ctx: Ctx) => Address | Promise<Address>);

export interface RouteSpec<Ctx> {
  /** "$0.01", "0.01", 0.01 (USD == SBC), or { amount: "10000" } atomic units. */
  price: Price | ((ctx: Ctx) => Price | Promise<Price>);
  description?: string;
  mimeType?: string;
  /** Seconds the signed payment stays valid. Default 300. */
  maxTimeoutSeconds?: number;
  /** Per-route recipient override. */
  payTo?: PayTo<Ctx>;
}

/**
 * Protected routes keyed "METHOD /path" (`*` wildcards allowed, e.g. "GET /api/*").
 * A bare price is shorthand for `{ price }`.
 */
export type RouteSpecs<Ctx> = Record<string, RouteSpec<Ctx> | Price>;

export interface RoutesOptions<Ctx> {
  /** Recipient of every payment (unless a route overrides it). */
  payTo: PayTo<Ctx>;
  routes: RouteSpecs<Ctx>;
}

export interface RadiusServerOptions extends NetworkOverrides {
  /** 'mainnet' (default), 'testnet', a preset, or a custom instance. */
  network?: NetworkInput;
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
  /**
   * Called once per settled payment, whichever adapter served the request. `context`
   * is the x402 request context; `requestOf(context)` gives the `Request` when the
   * SDK's own adapter handled it.
   *
   * Records settlement, not delivery: with `settle: 'before'` it fires before the handler
   * runs, and the handler may still fail or return an error. Errors thrown here are logged
   * by x402 core, not surfaced to the buyer. Persist the receipt and the delivery outcome
   * separately so a paid 5xx (or an uncertain 502) can be reconciled before the buyer pays again.
   */
  onSettled?: (receipt: PaymentReceipt, context: HTTPRequestContext | undefined) => void | Promise<void>;
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

/** Turn a facilitator settle result into the receipt handed to application code. */
export function toReceipt(r: SettleResponse, network: RadiusNetwork, requirements: { amount: string }): PaymentReceipt {
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

/**
 * Radius payments for any HTTP stack. Holds the x402 resource server (Radius scheme,
 * facilitator, gas-sponsoring rules) independently of how requests arrive:
 *
 * - `server` + `routes()` plug into the upstream adapters (`@x402/express`,
 *   `@x402/next`, `@x402/hono`): `paymentMiddleware(radius.routes({...}), radius.server)`.
 * - `handler()` serves web-standard `Request` → `Response` directly (Workers, Bun,
 *   Deno, Node, route handlers). `radius-sdk/hono` wraps it for Hono.
 */
export class RadiusServer {
  readonly network: RadiusNetwork;
  /** The facilitator, wrapped so calls that fail without its own answer surface as 502 (`withUnknownOutcomes`). */
  readonly facilitator: FacilitatorClient;
  readonly scheme: RadiusExactScheme;
  /** The x402 resource server, for upstream framework adapters. */
  readonly server: x402ResourceServer;

  constructor(options: RadiusServerOptions = {}) {
    this.network = resolveNetwork(options.network, options);
    this.facilitator = withUnknownOutcomes(isFacilitatorClient(options.facilitator) ? options.facilitator : new RadiusFacilitatorClient(this.network, options.facilitator));
    this.scheme = new RadiusExactScheme(this.network, options.settle ?? 'before', options.gasSponsoring ?? 'auto');
    this.server = new x402ResourceServer(this.facilitator).register(this.network.network, this.scheme);
    if (options.onSettled) this.onSettled(options.onSettled);
  }

  /** Register a settlement listener (see `RadiusServerOptions.onSettled`). */
  onSettled(hook: NonNullable<RadiusServerOptions['onSettled']>): this {
    this.server.onAfterSettle(async (ctx) => {
      if (!ctx.result.success) return;
      const transport = ctx.transportContext as { request?: HTTPRequestContext } | undefined;
      await hook(toReceipt(ctx.result as SettleResponse, this.network, ctx.requirements), transport?.request);
    });
    return this;
  }

  /**
   * x402 `RoutesConfig` with Radius pricing (USD/SBC display units or atomic amounts)
   * and the gas-sponsoring declaration. Dynamic `payTo`/`price` receive the x402
   * request context.
   */
  routes(options: RoutesOptions<HTTPRequestContext>): RoutesConfig {
    return this.buildRoutes(options, (ctx) => ctx);
  }

  /** `routes()` with dynamic functions receiving a framework-specific context. @internal */
  buildRoutes<Ctx>(options: RoutesOptions<Ctx>, contextOf: (ctx: HTTPRequestContext) => Ctx): RoutesConfig {
    const network = this.network;
    const resolvePayTo = (spec: PayTo<Ctx>) => (typeof spec === 'function' ? (ctx: HTTPRequestContext) => spec(contextOf(ctx)) : spec);
    const normalise = (p: Price) => resolvePrice(p, network.asset);
    const routes: RoutesConfig = {};
    for (const [pattern, specOrPrice] of Object.entries(options.routes)) {
      const spec: RouteSpec<Ctx> =
        typeof specOrPrice === 'object' && specOrPrice !== null && 'price' in specOrPrice ? (specOrPrice as RouteSpec<Ctx>) : { price: specOrPrice as Price };
      const price = spec.price;
      const route: RouteConfig & { extensions?: Record<string, unknown> } = {
        accepts: {
          scheme: 'exact',
          network: network.network,
          payTo: resolvePayTo(spec.payTo ?? options.payTo),
          price: typeof price === 'function' ? async (ctx: HTTPRequestContext) => normalise(await price(contextOf(ctx))) : normalise(price),
          maxTimeoutSeconds: spec.maxTimeoutSeconds ?? 300,
        },
        description: spec.description,
        mimeType: spec.mimeType,
        extensions: { ...GAS_SPONSORING_DECLARATION },
      };
      routes[pattern] = route;
    }
    return routes;
  }

  /** An `x402HTTPResourceServer` for these routes (`paymentMiddlewareFromHTTPServer` in upstream adapters). */
  http(options: RoutesOptions<HTTPRequestContext>): x402HTTPResourceServer {
    return new x402HTTPResourceServer(this.server, this.routes(options));
  }

  /** Web-standard handler for these routes; dynamic `payTo`/`price` receive the `Request`. */
  handler(options: RoutesOptions<Request>): PaymentHandler {
    return createPaymentHandler(this, this.buildRoutes(options, (ctx) => requestOf(ctx) ?? missingRequest()));
  }
}

function missingRequest(): never {
  throw new Error('radius-sdk: request context was not produced by RequestAdapter');
}

export function createRadiusServer(options: RadiusServerOptions = {}): RadiusServer {
  return new RadiusServer(options);
}

/** The application handler behind a paid route. `payment` is set when settlement ran before the handler (`settle: 'before'`, the default). */
export type NextHandler = (request: Request, payment?: PaymentReceipt) => Response | Promise<Response>;

export interface PaymentHandler {
  /** Charge for `request` if it matches a paid route, then call `next` (or answer 402 / errors). */
  (request: Request, next: NextHandler): Promise<Response>;
  /** `handler => request => Response`, for runtimes that take a single fetch function. */
  wrap(next: NextHandler): (request: Request) => Promise<Response>;
  /** True when `request` matches a paid route (cheap, no network). */
  requiresPayment(request: Request): boolean;
  readonly radius: RadiusServer;
}

export interface RadiusPaymentsOptions extends Omit<RadiusServerOptions, 'onSettled'>, RoutesOptions<Request> {
  /** Called once per settled payment with the `Request` that paid. */
  onSettled?: (receipt: PaymentReceipt, request: Request) => void | Promise<void>;
}

/**
 * Charge for routes with Radius x402 payments, for any runtime that speaks
 * web-standard `Request`/`Response`:
 *
 * ```ts
 * const pay = radiusPayments({ network: 'testnet', payTo: '0x…', routes: { 'GET /api/lookup': '$0.001' } });
 * export default { fetch: pay.wrap((request, payment) => Response.json({ paidBy: payment?.payer })) };
 * ```
 *
 * Standard x402 v2 on the wire: unpaid requests get a 402 with a `PAYMENT-REQUIRED`
 * header; paid requests carry `PAYMENT-SIGNATURE`, are verified and settled through
 * the facilitator, and get a `PAYMENT-RESPONSE` header back.
 */
export function radiusPayments(options: RadiusPaymentsOptions): PaymentHandler {
  const { payTo, routes, onSettled, ...serverOptions } = options;
  const radius = new RadiusServer({
    ...serverOptions,
    onSettled: onSettled && ((receipt, ctx) => onSettled(receipt, requestOf(ctx) ?? missingRequest())),
  });
  return radius.handler({ payTo, routes });
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function instructionsToResponse(r: HTTPResponseInstructions): Response {
  const res = r.isHtml ? new Response(String(r.body ?? ''), { status: r.status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }) : jsonResponse(r.body ?? {}, r.status);
  for (const [k, v] of Object.entries(r.headers)) res.headers.set(k, v);
  return res;
}

function facilitatorErrorResponse(error: FacilitatorResponseError): Response {
  return jsonResponse({ error: 'facilitator_error', message: error.message }, 502);
}

function internalErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: 'payment_processing_error', message }, 500);
}

function errorResponse(error: unknown): Response {
  const fe = getFacilitatorResponseError(error);
  return fe ? facilitatorErrorResponse(fe) : internalErrorResponse(error);
}

function setHeaders(res: Response, headers: Record<string, string> | undefined): void {
  if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
}

/** A copy of `res` whose headers are mutable (responses from `fetch()` have immutable headers). */
function mutable(res: Response, body: BodyInit | null = res.body): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Web-standard handler for an already-built x402 `RoutesConfig` (see `RadiusServer.buildRoutes`). @internal */
export function createPaymentHandler(radius: RadiusServer, routes: RoutesConfig): PaymentHandler {
  const { network } = radius;
  const httpServer = new x402HTTPResourceServer(radius.server, routes);

  // Lazy, request-time initialisation: Workers forbid I/O at module scope, and the
  // static facilitator answer means this is normally just bookkeeping anyway.
  let initPromise: Promise<void> | undefined;
  const ensureInitialized = () =>
    (initPromise ??= httpServer.initialize().catch((e) => {
      initPromise = undefined;
      throw e;
    }));

  const handle = async (request: Request, next: NextHandler): Promise<Response> => {
    const context = requestContext(request);
    if (!httpServer.requiresPayment(context)) return next(request);

    try {
      await ensureInitialized();
    } catch (error) {
      return errorResponse(error);
    }

    let result: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (error) {
      return errorResponse(error);
    }

    if (result.type === 'no-payment-required') return next(request);
    if (result.type === 'payment-error') return instructionsToResponse(result.response);

    const { cancellationDispatcher, beforeHandlerSettlement, paymentPayload, paymentRequirements, declaredExtensions } = result;
    const payment = beforeHandlerSettlement ? toReceipt(beforeHandlerSettlement.result, network, paymentRequirements) : undefined;

    let res: Response;
    try {
      res = await next(request, payment);
    } catch (error) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_threw', error: error as Error });
      if (!beforeHandlerSettlement && !cancelSettlement) throw error;
      const failure = internalErrorResponse(error);
      setHeaders(failure, httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, failure.headers.get('Cache-Control')));
      return failure;
    }

    if (res.status >= 400) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_failed', responseStatus: res.status });
      const failure = mutable(res);
      failure.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
      setHeaders(failure, httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, failure.headers.get('Cache-Control')));
      return failure;
    }

    // Settlement already happened in the 'before' flow: core only echoes its headers, so the
    // handler's body streams through untouched. The 'after' flow settles on the finished
    // response and needs the body in hand.
    const responseBody = beforeHandlerSettlement ? undefined : new Uint8Array(await res.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    try {
      const settleResult = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        { request: context, responseBody, responseHeaders },
        undefined,
        beforeHandlerSettlement,
      );
      if (!settleResult.success) return instructionsToResponse(settleResult.response);
      const out = mutable(res, responseBody ?? res.body);
      setHeaders(out, settleResult.headers);
      out.headers.set('Cache-Control', withPrivateCacheControl(out.headers.get('Cache-Control')));
      out.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
      return out;
    } catch (error) {
      if (error instanceof FacilitatorResponseError) return facilitatorErrorResponse(error);
      console.error(error);
      return jsonResponse({ error: 'settlement_error' }, 402);
    }
  };

  const handler = handle as PaymentHandler;
  Object.defineProperties(handler, {
    radius: { value: radius, enumerable: true },
    wrap: { value: (next: NextHandler) => (request: Request) => handle(request, next), enumerable: true },
    requiresPayment: { value: (request: Request) => httpServer.requiresPayment(requestContext(request)), enumerable: true },
  });
  return handler;
}
