import type { PaymentRequired } from '@x402/core/types';
import { isAddress, type Chain } from 'viem';
import type { Price } from '../amounts.js';
import { RadiusPaymentError } from '../errors.js';
import type { Address, Caip2, RadiusAsset } from '../networks.js';
import type { Settlement } from '../settlement.js';
import { createSingleNetworkBuyer, type AnyPaymentRequirements, type RadiusFetchOptions, type RadiusSigner } from './buyer.js';

/** An explicitly allowed ERC-20 and its independent per-request spending limit. */
export interface EvmAssetConfig {
  /** Complete metadata: no SBC defaults are applied. name/version are the token's EIP-712 domain. */
  asset: RadiusAsset;
  /** Token units ("0.05") or atomic units ({ amount: "50000" }); no exchange-rate conversion. */
  maxPerRequest: Price;
}

/** A supported EVM chain, with its own RPC, signer and allowed payment assets. */
export interface EvmNetworkConfig {
  /** Any viem EVM Chain, including Base, Arc, Monad, Polygon, Arbitrum and Radius. */
  chain: Chain;
  rpcUrl?: string;
  /** Overrides the default signer. A WalletClient must be configured for this chain. */
  signer?: RadiusSigner;
  assets: readonly EvmAssetConfig[];
  /** Defaults to 'never'. 'auto' permits an unlimited ERC-20 approval and spends this chain's gas token. */
  permit2Approval?: 'auto' | 'never';
}

export interface EvmFetchOptions extends Pick<RadiusFetchOptions, 'onPaymentRequired' | 'onApprovalRequired' | 'onPaid' | 'fetch'> {
  networks: readonly EvmNetworkConfig[];
  /** Default signer, used by chains that do not supply their own. */
  signer?: RadiusSigner;
}

/** Resolved payment context. Contains no signing credentials. */
export interface EvmPaymentRoute {
  readonly network: Caip2;
  readonly asset: Readonly<RadiusAsset>;
  readonly address: Address;
  /** Atomic cap for this network/asset pair. Not a cumulative budget. */
  readonly maxPerRequest: bigint;
  /** Reconcile transfers of this asset using this chain's RPC. */
  getSettlement(txHash: `0x${string}`): Promise<Settlement | undefined>;
}

export interface EvmFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly routes: readonly EvmPaymentRoute[];
}

/**
 * Pay x402 challenges across an explicit allowlist of EVM networks and assets.
 * Selects the first compatible offer within its own asset cap in server order.
 * A policy decline is final: it never falls back to another offer after authorization.
 * Requires CAIP-2 eip155 network IDs for both v1 and v2 challenges.
 */
export function createEvmFetch(options: EvmFetchOptions): EvmFetch {
  if (!options.networks?.length) throw new RadiusPaymentError('config', 'createEvmFetch: networks must not be empty');
  const buyers = new Map<string, ReturnType<typeof createSingleNetworkBuyer>>();
  const networks = new Set<string>();
  const routes: EvmPaymentRoute[] = [];
  const key = (network: string, asset: string) => `${network}/${asset.toLowerCase()}`;
  for (const config of options.networks) {
    const { chain } = config;
    if (!chain || !Number.isSafeInteger(chain.id) || chain.id <= 0) {
      throw new RadiusPaymentError('config', 'createEvmFetch: each network needs a viem EVM Chain with a positive chain id');
    }
    const network = `eip155:${chain.id}` as const;
    if (networks.has(network)) throw new RadiusPaymentError('config', `Duplicate network ${network}; put its assets in one entry`);
    networks.add(network);
    const rpcUrl = config.rpcUrl ?? chain.rpcUrls.default.http[0];
    if (!rpcUrl) throw new RadiusPaymentError('config', `No HTTP RPC configured for ${network}`);
    const signer = config.signer ?? options.signer;
    if (!signer) throw new RadiusPaymentError('config', `No signer configured for ${network}`);
    if (!config.assets?.length) throw new RadiusPaymentError('config', `No payment assets configured for ${network}`);
    for (const entry of config.assets) {
      const asset = entry.asset;
      if (!asset || !isAddress(asset.address) || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255 ||
          !asset.symbol || !asset.name || !asset.version) {
        throw new RadiusPaymentError('config', `Incomplete ERC-20 metadata for ${network}; address, decimals, symbol, name and version are required`);
      }
      const routeKey = key(network, asset.address);
      if (buyers.has(routeKey)) throw new RadiusPaymentError('config', `Duplicate payment asset ${asset.address} on ${network}`);
      const buyer = createSingleNetworkBuyer({
        signer, maxPerRequest: entry.maxPerRequest,
        permit2Approval: config.permit2Approval ?? 'never',
        onPaymentRequired: options.onPaymentRequired,
        onApprovalRequired: options.onApprovalRequired,
        onPaid: options.onPaid,
        fetch: options.fetch,
      }, {
        name: chain.name, chain, network, rpcUrl,
        explorerUrl: chain.blockExplorers?.default.url,
        asset: { ...asset },
      });
      buyers.set(routeKey, buyer);
      routes.push(Object.freeze({ network, asset: Object.freeze({ ...asset }), address: buyer.address, maxPerRequest: buyer.maxPerRequest, getSettlement: buyer.getSettlement }));
    }
  }
  const firstBuyer = buyers.values().next().value!;
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const select = (challenge: PaymentRequired, url: string) => {
    if (challenge.x402Version !== 1 && challenge.x402Version !== 2) {
      throw new RadiusPaymentError('invalid_challenge', `Unsupported x402 version ${String(challenge.x402Version)}`);
    }
    if (!Array.isArray(challenge.accepts) || !challenge.accepts.length) throw new RadiusPaymentError('invalid_challenge', 'Challenge has no accepts[]');
    let failure: RadiusPaymentError | undefined;
    let matchesNetwork = false;
    for (const req of challenge.accepts as AnyPaymentRequirements[]) {
      if (!networks.has(req.network)) continue;
      matchesNetwork = true;
      if (typeof req.asset !== 'string') continue;
      const buyer = buyers.get(key(req.network, req.asset));
      if (!buyer) continue;
      try {
        const offer = buyer.chooseOffer({ ...challenge, accepts: [req] } as PaymentRequired, url);
        return { buyer, offer };
      } catch (e) {
        // An unsupported or unaffordable offer can coexist with a usable alternative.
        if (!(e instanceof RadiusPaymentError) || !['price_above_limit', 'no_compatible_offer', 'unsupported_transfer_method'].includes(e.code)) throw e;
        failure ??= e;
      }
    }
    if (failure) throw failure;
    throw new RadiusPaymentError(matchesNetwork ? 'asset_mismatch' : 'network_mismatch',
      matchesNetwork ? 'Server does not accept a configured payment asset on a supported network' : `Server offers no configured EVM network (${[...networks].join(', ')})`, challenge.accepts);
  };
  const paidFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.headers.has('payment-signature') || request.headers.has('x-payment')) return baseFetch(request);
    const retry = new Request(request.clone(), { redirect: 'manual' });
    const response = await baseFetch(request);
    if (response.status !== 402) return response;
    const challenge = await firstBuyer.readChallenge(response);
    const { buyer, offer } = select(challenge, request.url);
    return buyer.pay(retry, challenge, offer);
  };
  return Object.assign(paidFetch, { routes: Object.freeze(routes) });
}
