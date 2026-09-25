/**
 * Radius network presets and helpers.
 *
 * Chain identity (id, RPC, explorer, native currency) is a viem `Chain`, defined
 * here with the same values as viem's own `radius` / `radiusTestnet` entries.
 * They are not imported from `viem/chains`: that barrel loads several hundred
 * chain definitions and costs a CLI ~400 ms of startup. `radiusMainnetChain` /
 * `radiusTestnetChain` feed viem clients directly. A `RadiusNetwork` wraps one of
 * those chains with the Radius-specific pieces x402 needs (facilitator, faucet,
 * payment asset) and exposes a few fields derived from the chain for convenience.
 *
 * Values verified against docs.radiustech.xyz (network configuration, contract
 * addresses, x402 facilitator API) and the live facilitator `/supported`
 * responses on 2026-09-11.
 */

import type { Chain } from 'viem';

// Plain Chain objects keep root and seller imports independent of viem at runtime.

export type Address = `0x${string}`;
export type Caip2 = `eip155:${number}`;

export interface RadiusAsset {
  /** ERC-20 contract address. */
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 / EIP-2612 permit domain name. */
  name: string;
  /** EIP-712 / EIP-2612 permit domain version. */
  version: string;
}

export interface RadiusNetwork {
  /** Human label: 'mainnet', 'testnet', or whatever you call a custom instance. */
  name: string;
  /**
   * The viem chain — the source of truth for chain id, RPC, explorer and native
   * currency. Pass it to `createPublicClient` / `createWalletClient`.
   */
  chain: Chain;
  /** `chain.id`. */
  chainId: number;
  /** CAIP-2 identifier used on the x402 wire, e.g. `eip155:723487` (from `chain.id`). */
  network: Caip2;
  /** `chain.rpcUrls.default.http[0]`. */
  rpcUrl: string;
  facilitatorUrl: string;
  /** `chain.blockExplorers.default.url`, when the chain declares one. */
  explorerUrl?: string;
  /** Faucet API base URL (drips SBC; testnet ~0.5/request, mainnet ~0.01/day). */
  faucetUrl?: string;
  /** Default payment asset (SBC unless overridden). */
  asset: RadiusAsset;
  /** `chain.testnet ?? false`. */
  testnet: boolean;
}

/** Radius mainnet (id 723487). Same values as viem's `radius`. */
export const radiusMainnetChain: Chain = {
  id: 723_487,
  name: 'Radius Network',
  nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.radiustech.xyz'] } },
  blockExplorers: { default: { name: 'Radius Network Explorer', url: 'https://network.radiustech.xyz' } },
  testnet: false,
};

/** Radius testnet (id 72344). Same values as viem's `radiusTestnet`. */
export const radiusTestnetChain: Chain = {
  id: 72_344,
  name: 'Radius Test Network',
  nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.radiustech.xyz'] } },
  blockExplorers: { default: { name: 'Radius Test Network Explorer', url: 'https://testnet.radiustech.xyz' } },
  testnet: true,
};

/** SBC is deployed deterministically: same address on mainnet and testnet. */
export const SBC: RadiusAsset = {
  address: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
  symbol: 'SBC',
  decimals: 6,
  name: 'Stable Coin',
  version: '1',
};

/** Canonical Uniswap Permit2 (same address on every EVM chain). */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** x402ExactPermit2Proxy — the Permit2 spender payers sign for in the `exact` scheme. */
export const X402_EXACT_PERMIT2_PROXY: Address = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

export type NetworkName = 'mainnet' | 'testnet';

interface CustomNetworkBase {
  facilitatorUrl: string;
  /** Label for messages; defaults to the chain name (or `radius-<chainId>`). */
  name?: string;
  faucetUrl?: string;
  /** Partial override; unspecified fields fall back to SBC. */
  asset?: Partial<RadiusAsset>;
}

/** A custom instance described by a viem chain (optionally overriding its RPC / explorer). */
export interface CustomNetworkFromChain extends CustomNetworkBase {
  chain: Chain;
  rpcUrl?: string;
  explorerUrl?: string;
}

/** A custom instance described by chain id + RPC; a viem chain is built from them. */
export interface CustomNetworkFromChainId extends CustomNetworkBase {
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  /** Defaults to true for custom instances. */
  testnet?: boolean;
}

export type CustomNetworkConfig = CustomNetworkFromChain | CustomNetworkFromChainId;

/** Anything `resolveNetwork` understands. Defaults to mainnet when omitted. */
export type NetworkInput = NetworkName | RadiusNetwork | CustomNetworkConfig;

export interface NetworkOverrides {
  rpcUrl?: string;
  facilitatorUrl?: string;
  explorerUrl?: string;
  faucetUrl?: string;
  /** Override the payment asset (e.g. a different token on a custom instance). */
  asset?: Partial<RadiusAsset>;
}

/** Build a network definition for a custom Radius instance, from a viem chain or a chain id + RPC. */
export function defineRadiusNetwork(config: CustomNetworkConfig): RadiusNetwork {
  if (!config.facilitatorUrl) throw new Error('defineRadiusNetwork: facilitatorUrl is required');
  let chain: Chain;
  if ('chain' in config) {
    if (!config.chain || !Number.isInteger(config.chain.id)) throw new Error('defineRadiusNetwork: chain must be a viem Chain');
    chain = withChainOverrides(config.chain, config);
  } else {
    if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
      throw new Error(`defineRadiusNetwork: chainId must be a positive integer (got ${config.chainId})`);
    }
    if (!config.rpcUrl) throw new Error('defineRadiusNetwork: rpcUrl is required');
    chain = {
      id: config.chainId,
      name: config.name ?? `radius-${config.chainId}`,
      nativeCurrency: radiusMainnetChain.nativeCurrency,
      rpcUrls: { default: { http: [stripTrailingSlash(config.rpcUrl)] } },
      blockExplorers: config.explorerUrl ? { default: { name: 'Explorer', url: stripTrailingSlash(config.explorerUrl) } } : undefined,
      testnet: config.testnet ?? true,
    };
  }
  return fromChain(chain, {
    name: config.name,
    facilitatorUrl: stripTrailingSlash(config.facilitatorUrl),
    faucetUrl: config.faucetUrl,
    asset: { ...SBC, ...config.asset },
  });
}

export const radiusMainnet: RadiusNetwork = fromChain(radiusMainnetChain, {
  name: 'mainnet',
  facilitatorUrl: 'https://facilitator.radiustech.xyz',
  faucetUrl: 'https://network.radiustech.xyz/api/v1/faucet',
  asset: SBC,
});

export const radiusTestnet: RadiusNetwork = fromChain(radiusTestnetChain, {
  name: 'testnet',
  facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz',
  faucetUrl: 'https://testnet.radiustech.xyz/api/v1/faucet',
  asset: SBC,
});

function isRadiusNetwork(v: unknown): v is RadiusNetwork {
  return typeof v === 'object' && v !== null && 'chain' in v && 'network' in v && 'asset' in v;
}

/**
 * Resolve a network from a name, a preset, or a custom config, applying overrides.
 * Defaults to mainnet.
 */
export function resolveNetwork(input?: NetworkInput, overrides?: NetworkOverrides): RadiusNetwork {
  let base: RadiusNetwork;
  if (input === undefined || input === 'mainnet') base = radiusMainnet;
  else if (input === 'testnet') base = radiusTestnet;
  else if (isRadiusNetwork(input)) base = input;
  else if (typeof input === 'object') base = defineRadiusNetwork(input);
  else throw new Error(`resolveNetwork: unknown network '${String(input)}' (expected 'mainnet', 'testnet', or a network object)`);

  // A spread-and-edited preset (`{ ...radiusTestnet, rpcUrl }`) leaves `chain` stale;
  // treat convenience fields that disagree with the chain as overrides of it.
  const rpcUrl = overrides?.rpcUrl ?? (base.rpcUrl !== rpcUrlOf(base.chain) ? base.rpcUrl : undefined);
  const explorerUrl = overrides?.explorerUrl ?? (base.explorerUrl !== explorerUrlOf(base.chain) ? base.explorerUrl : undefined);
  if (!overrides && !rpcUrl && !explorerUrl) return base;
  return fromChain(withChainOverrides(base.chain, { rpcUrl, explorerUrl }), {
    name: base.name,
    facilitatorUrl: overrides?.facilitatorUrl ? stripTrailingSlash(overrides.facilitatorUrl) : base.facilitatorUrl,
    faucetUrl: overrides?.faucetUrl ?? base.faucetUrl,
    asset: overrides?.asset ? { ...base.asset, ...overrides.asset } : base.asset,
  });
}

/** Parse a CAIP-2 `eip155:<id>` string to a chain id, or undefined. */
/** The preset whose chain id matches (mainnet 723487, testnet 72344), if any. */
export function radiusNetworkForChainId(chainId: number | undefined): RadiusNetwork | undefined {
  if (chainId === radiusMainnet.chainId) return radiusMainnet;
  if (chainId === radiusTestnet.chainId) return radiusTestnet;
  return undefined;
}

export function chainIdFromCaip2(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** Explorer link for a settlement transaction, e.g. https://testnet.radiustech.xyz/tx/0x… */
export function explorerTxUrl(network: RadiusNetwork, txHash: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${txHash}` : undefined;
}

/** Assemble a RadiusNetwork whose convenience fields are derived from `chain`. */
function fromChain(chain: Chain, radius: { name?: string; facilitatorUrl: string; faucetUrl?: string; asset: RadiusAsset }): RadiusNetwork {
  return {
    name: radius.name ?? chain.name,
    chain,
    chainId: chain.id,
    network: `eip155:${chain.id}`,
    rpcUrl: rpcUrlOf(chain),
    facilitatorUrl: radius.facilitatorUrl,
    explorerUrl: explorerUrlOf(chain),
    faucetUrl: radius.faucetUrl,
    asset: radius.asset,
    testnet: chain.testnet ?? false,
  };
}

/** Return `chain` with its default RPC / explorer replaced (a new chain; the input is untouched). */
function withChainOverrides(chain: Chain, o: { rpcUrl?: string; explorerUrl?: string }): Chain {
  if (!o.rpcUrl && !o.explorerUrl) return chain;
  const explorerName = chain.blockExplorers?.default.name ?? 'Explorer';
  return {
    ...chain,
    rpcUrls: o.rpcUrl ? { ...chain.rpcUrls, default: { ...chain.rpcUrls.default, http: [stripTrailingSlash(o.rpcUrl)] } } : chain.rpcUrls,
    blockExplorers: o.explorerUrl
      ? { ...chain.blockExplorers, default: { name: explorerName, url: stripTrailingSlash(o.explorerUrl) } }
      : chain.blockExplorers,
  };
}

function rpcUrlOf(chain: Chain): string {
  const url = chain.rpcUrls.default.http[0];
  if (!url) throw new Error(`Chain ${chain.id} (${chain.name}) declares no default HTTP RPC URL`);
  return url;
}

function explorerUrlOf(chain: Chain): string | undefined {
  return chain.blockExplorers?.default.url;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
