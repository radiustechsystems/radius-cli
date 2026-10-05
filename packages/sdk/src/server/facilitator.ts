import { FacilitatorResponseError, HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements, type SettleResponse, type SupportedResponse, type VerifyResponse } from '@x402/core/types';
import type { RadiusNetwork } from '../networks.js';

export interface FacilitatorOptions {
  /** Override the facilitator base URL (defaults to the network's facilitator). */
  url?: string;
  /** Sent as `x-api-key` on verify/settle/supported. */
  apiKey?: string;
  /**
   * Default true: `/supported` is fetched from the facilitator on the first paid
   * request after each cold start, so facilitator changes propagate without an SDK
   * update. Set false to use the built-in answer for Radius (no network call before
   * the first 402; goes stale if the facilitator changes).
   */
  live?: boolean;
  timeoutMs?: number;
}

/** The `/supported` answer the Radius facilitators return for a network (exact / Permit2 / SBC). */
export function staticSupported(network: RadiusNetwork): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: network.network,
        extra: {
          assetTransferMethod: 'permit2',
          name: network.asset.name,
          version: network.asset.version,
        },
      },
    ],
    extensions: ['eip2612GasSponsoring'],
    signers: {},
  };
}

/**
 * FacilitatorClient for a hosted x402 facilitator (Radius's by default). Nothing
 * runs at construction; the first `/supported` lookup happens lazily at request time
 * (Cloudflare Workers forbid I/O at module scope).
 */
export class RadiusFacilitatorClient implements FacilitatorClient {
  readonly url: string;
  private readonly http: HTTPFacilitatorClient;
  private readonly live: boolean;
  private readonly network: RadiusNetwork;

  constructor(network: RadiusNetwork, options: FacilitatorOptions = {}) {
    this.network = network;
    this.url = (options.url ?? network.facilitatorUrl).replace(/\/+$/, '');
    this.live = options.live ?? true;
    const auth = options.apiKey ? { 'x-api-key': options.apiKey } : undefined;
    this.http = new HTTPFacilitatorClient({
      url: this.url,
      timeoutMs: options.timeoutMs,
      createAuthHeaders: auth ? async () => ({ verify: auth, settle: auth, supported: auth }) : undefined,
    });
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.http.verify(paymentPayload, paymentRequirements);
  }

  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.http.settle(paymentPayload, paymentRequirements);
  }

  getSupported(): Promise<SupportedResponse> {
    return this.live ? this.http.getSupported() : Promise.resolve(staticSupported(this.network));
  }
}

/**
 * A facilitator call that fails without the facilitator's own answer (a network error, or an
 * error status whose body is not an x402 response) leaves the outcome unknown: a settle may
 * have reached the chain. @x402/core reports those as a `402`, which a buyer reads as "rejected,
 * nothing moved", so this rethrows them as `FacilitatorResponseError`, which `radiusPayments`
 * answers with `502`. The facilitator's own answers (`VerifyError`, `SettleError`) pass through.
 */
export function withUnknownOutcomes(facilitator: FacilitatorClient): FacilitatorClient {
  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FacilitatorResponseError || error instanceof VerifyError || error instanceof SettleError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new FacilitatorResponseError(`Facilitator ${operation} failed: ${message}`), { cause: error });
    }
  };
  return {
    verify: (payload, requirements) => call('verify', () => facilitator.verify(payload, requirements)),
    settle: (payload, requirements) => call('settle', () => facilitator.settle(payload, requirements)),
    getSupported: () => call('supported', () => facilitator.getSupported()),
  };
}
