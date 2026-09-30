import { x402Client } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { isAddress, type Chain } from 'viem';
import type { Price } from '../amounts.js';
import { RadiusPaymentError } from '../errors.js';
import type { Address, Caip2, RadiusAsset } from '../networks.js';
import type { Settlement } from '../settlement.js';
import { createPaymentFetch, createSingleNetworkBuyer, type AnyPaymentRequirements, type PaymentOffer, type RadiusFetchOptions, type RadiusSigner } from './buyer.js';

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
 * Uses upstream network/scheme selection, payment-flow preference and per-asset caps.
 * A policy decline is final: it never falls back to another offer after authorization.
 * Requires CAIP-2 eip155 network IDs for both v1 and v2 challenges.
 */
export function createEvmFetch(options: EvmFetchOptions): EvmFetch {
  if (!options.networks?.length) throw new RadiusPaymentError('config', 'createEvmFetch: networks must not be empty');
  const client = new x402Client();
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
      }, client);
      buyers.set(routeKey, buyer);
      routes.push(Object.freeze({ network, asset: Object.freeze({ ...asset }), address: buyer.address, maxPerRequest: buyer.maxPerRequest, getSettlement: buyer.getSettlement }));
    }
  }
  // Upstream spend controls know token caps, but also allow recognized default tokens.
  // The policy makes our configured assets a strict allowlist and excludes transfer
  // methods this adapter cannot execute. Network/scheme/flow selection stays upstream.
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: routes.map(route => ({ network: route.network, asset: route.asset.address, maxAmountPerPayment: route.maxPerRequest.toString() })),
  });
  client.registerPolicy((version, requirements) => requirements.filter(req => {
    if (typeof req.asset !== 'string' || !buyers.has(key(req.network, req.asset))) return false;
    const method = req.extra?.assetTransferMethod;
    return version === 1 || req.scheme === 'upto' || method === undefined || method === 'permit2' || method === 'eip3009';
  }));

  // Preserve the SDK's actionable error codes if upstream finds no payable offer.
  // This only diagnoses a refusal; it never chooses or signs an alternative.
  const explainRefusal = (challenge: PaymentRequired, url: string, cause: unknown): never => {
    let failure: RadiusPaymentError | undefined;
    let matchesNetwork = false;
    let matchesAsset = false;
    for (const req of challenge.accepts as AnyPaymentRequirements[]) {
      if (!networks.has(req.network)) continue;
      matchesNetwork = true;
      if (typeof req.asset !== 'string') continue;
      const buyer = buyers.get(key(req.network, req.asset));
      if (!buyer) continue;
      matchesAsset = true;
      try {
        buyer.chooseOffer({ ...challenge, accepts: [req] } as PaymentRequired, url);
      } catch (error) {
        if (!(error instanceof RadiusPaymentError)) throw error;
        failure ??= error;
      }
    }
    if (failure) throw failure;
    if (matchesAsset) throw new RadiusPaymentError('no_compatible_offer', 'No payment offer passed the x402 client policies', cause);
    throw new RadiusPaymentError(matchesNetwork ? 'asset_mismatch' : 'network_mismatch',
      matchesNetwork ? 'Server does not accept a configured payment asset on a supported network' : `Server offers no configured EVM network (${[...networks].join(', ')})`, challenge.accepts);
  };
  type Buyer = ReturnType<typeof createSingleNetworkBuyer>;
  interface RequestContext {
    url: string;
    originals: Map<PaymentRequirements, AnyPaymentRequirements>;
    selected?: { buyer: Buyer; offer: PaymentOffer };
  }
  const requests = new WeakMap<PaymentRequired, RequestContext>();
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    const context = requests.get(paymentRequired)!;
    const buyer = buyers.get(key(selectedRequirements.network, selectedRequirements.asset))!;
    const original = context.originals.get(selectedRequirements)!;
    const offer = buyer.chooseOffer({ ...paymentRequired, accepts: [original] } as PaymentRequired, context.url);
    context.selected = { buyer, offer };
    // Core calls this hook after selection and before the EVM scheme signs anything.
    await buyer.authorize(offer);
  });

  const firstBuyer = buyers.values().next().value!;
  const paidFetch = createPaymentFetch(options.fetch ?? globalThis.fetch.bind(globalThis), firstBuyer.readChallenge, async (retry, challenge, url) => {
    if (challenge.x402Version !== 1 && challenge.x402Version !== 2) {
      throw new RadiusPaymentError('invalid_challenge', `Unsupported x402 version ${String(challenge.x402Version)}`);
    }
    if (!Array.isArray(challenge.accepts) || !challenge.accepts.length) throw new RadiusPaymentError('invalid_challenge', 'Challenge has no accepts[]');
    // Give upstream signing token metadata and bounded deadlines without changing the
    // server's original requirements, which must be echoed in the payment payload.
    const context: RequestContext = { url, originals: new Map() };
    const signingChallenge: PaymentRequired = { ...challenge, accepts: challenge.accepts.map(req => {
      const buyer = typeof req.asset === 'string' ? buyers.get(key(req.network, req.asset)) : undefined;
      const copy = buyer ? buyer.forSigning(req) : { ...req };
      context.originals.set(copy, req);
      return copy;
    }) };
    requests.set(signingChallenge, context);
    try {
      // Public core API owns network/scheme/flow selection, spend limits and signing.
      const payload = await client.createPaymentPayload(signingChallenge);
      const { buyer, offer } = context.selected!;
      return buyer.sendPaid(retry, offer, payload);
    } catch (cause) {
      // Once selected, policy/approval/signing failures must remain terminal.
      if (context.selected) throw cause;
      return explainRefusal(challenge, url, cause);
    } finally {
      requests.delete(signingChallenge);
    }
  });
  return Object.assign(paidFetch, { routes: Object.freeze(routes) });
}
