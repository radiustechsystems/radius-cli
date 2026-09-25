/**
 * Balance queries that account for how Radius differs from other EVM chains.
 *
 * On Radius, `eth_getBalance` (viem's `getBalance`) does not return the account's native
 * RUSD. It returns native RUSD **plus** the account's convertible stablecoin holdings (SBC)
 * valued 1:1 through the Turnstile, scaled to 18 decimals, so that wallets and tooling see
 * everything the account can spend. Reading `eth_getBalance` and an ERC-20 `balanceOf` and
 * adding them double-counts the stablecoin. See docs.radiustech.xyz, "JSON-RPC API".
 *
 * The EVM itself is unchanged: the `BALANCE` opcode (and Solidity's `address.balance`) sees
 * only the native amount. `getNativeBalance` uses that to read the raw native balance with a
 * plain `eth_call` whose init code executes `BALANCE` and returns it, so no contract needs to
 * be deployed and any standard node answers it. Stablecoin balances are ordinary ERC-20
 * `balanceOf` reads and are never aggregated.
 *
 * Everything here is viem-native: actions take a viem `Client` as the first argument and
 * `radiusActions()` is a client extension (`createPublicClient({...}).extend(radiusActions())`).
 */

import { formatUnits, hexToBigInt, isAddress, numberToHex, type Address, type BlockTag, type Chain, type Client, type Hex, type Transport } from 'viem';
import { getBalance, readContract } from 'viem/actions';
import { radiusMainnet, radiusNetworkForChainId, resolveNetwork, SBC, type NetworkInput, type RadiusAsset } from './networks.js';

/** Any viem client (public, wallet, or bare) whose transport reaches a Radius node. */
export type BalanceClient = Client<Transport, Chain | undefined>;

/** An ERC-20 to include in a balance query. `RadiusAsset` values (e.g. `SBC`) work as-is. */
export interface BalanceToken {
  address: Address;
  symbol: string;
  decimals: number;
  /**
   * Whether the Turnstile counts this token in `eth_getBalance` (SBC: yes). Used by the
   * derived fallback of `getBalances`; defaults to true for SBC and false otherwise.
   */
  convertible?: boolean;
}

export interface TokenBalance {
  address: Address;
  symbol: string;
  decimals: number;
  convertible: boolean;
  /** Raw ERC-20 `balanceOf`, in the token's base units. */
  atomic: bigint;
  /** Display amount, e.g. "10.5". */
  formatted: string;
}

export interface NativeBalance {
  /** From `chain.nativeCurrency` (RUSD). */
  symbol: string;
  /** From `chain.nativeCurrency` (18). */
  decimals: number;
  /** Native RUSD only, in wei: what the EVM `BALANCE` opcode sees. Excludes stablecoins. */
  raw: bigint;
  rawFormatted: string;
  /** What `eth_getBalance` returns: `raw` plus convertible stablecoins valued 1:1, in wei. */
  aggregate: bigint;
  aggregateFormatted: string;
  /** `aggregate - raw`: the stablecoin value the Turnstile would convert on demand, in wei. */
  convertible: bigint;
  convertibleFormatted: string;
  /**
   * How `raw` was obtained: `evm` read it with the `BALANCE` opcode; `derived` subtracted the
   * convertible token balances from `aggregate` because the EVM read failed (see `rawError`).
   */
  rawSource: 'evm' | 'derived';
  /** Message of the failed EVM read when `rawSource` is `derived`. */
  rawError?: string;
}

export interface AccountBalances {
  address: Address;
  native: NativeBalance;
  /** One entry per requested token, in the order requested. */
  tokens: TokenBalance[];
  /**
   * `native.raw` plus the convertible tokens valued 1:1, in 18 decimals: what the account can
   * spend through the Turnstile. Tokens not marked `convertible` are reported in `tokens` but
   * left out, since nothing says they are worth 1:1 with RUSD. Equals `native.aggregate` when
   * the requested tokens include every convertible one.
   */
  total: bigint;
  totalFormatted: string;
}

interface BlockArgs {
  /** Query at this block number instead of `latest`. */
  blockNumber?: bigint;
  /** Query at this block tag (default `latest`). Ignored when `blockNumber` is set. */
  blockTag?: BlockTag;
}

export interface GetNativeBalanceParameters extends BlockArgs {
  address: Address;
}

export interface GetTokenBalanceParameters extends BlockArgs {
  address: Address;
  token: BalanceToken;
}

export interface GetBalancesParameters extends BlockArgs {
  address: Address;
  /**
   * Tokens to read. Defaults to the network's payment asset (SBC), chosen from `network` when
   * given, else from the client's chain id, else the deterministic SBC address.
   */
  tokens?: BalanceToken[];
  /** Picks the default `tokens`; not needed when the client has a Radius chain. */
  network?: NetworkInput;
  /**
   * How to obtain `native.raw`. `auto` (default): the EVM read, falling back to subtracting
   * convertible token balances from `eth_getBalance` if that call fails. `evm`: EVM read only
   * (throws on failure). `derived`: subtraction only, no `eth_call` for the native balance.
   */
  nativeBalance?: 'auto' | 'evm' | 'derived';
}

const ERC20_BALANCE_OF = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * EVM init code that returns `BALANCE(address)` as a 32-byte word. Sent as an `eth_call`
 * with no `to`, a node executes it as contract-creation code and returns its return data.
 *
 *   PUSH20 <address> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
 */
export function nativeBalanceBytecode(address: Address): Hex {
  if (!isAddress(address, { strict: false })) throw new Error(`nativeBalanceBytecode: not an address: ${address}`);
  return `0x73${address.slice(2).toLowerCase()}3160005260206000f3`;
}

function blockParam(args: BlockArgs): Hex | BlockTag {
  return args.blockNumber !== undefined ? numberToHex(args.blockNumber) : (args.blockTag ?? 'latest');
}

function blockArgsOf<T extends BlockArgs>(args: T): BlockArgs {
  return args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : args.blockTag ? { blockTag: args.blockTag } : {};
}

/**
 * The account's native RUSD balance in wei, **excluding** convertible stablecoins: the number
 * the EVM's `BALANCE` opcode sees, as opposed to the aggregate `eth_getBalance` returns.
 */
export async function getNativeBalance(client: BalanceClient, args: GetNativeBalanceParameters): Promise<bigint> {
  const data = nativeBalanceBytecode(args.address);
  const result = (await client.request({
    method: 'eth_call',
    params: [{ data }, blockParam(args)],
  })) as Hex;
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`getNativeBalance: eth_call returned ${JSON.stringify(result)} instead of a 32-byte word; the node may not execute init code in eth_call`);
  }
  return hexToBigInt(result);
}

/**
 * What `eth_getBalance` returns on Radius, in wei: native RUSD plus convertible stablecoins
 * valued 1:1. Identical to viem's `getBalance`; named so the aggregation is explicit at the
 * call site.
 */
export function getAggregateBalance(client: BalanceClient, args: GetNativeBalanceParameters): Promise<bigint> {
  return getBalance(client, { address: args.address, ...blockArgsOf(args) } as Parameters<typeof getBalance>[1]);
}

/** Raw ERC-20 `balanceOf` for one token (SBC or any other), never aggregated. */
export async function getTokenBalance(client: BalanceClient, args: GetTokenBalanceParameters): Promise<TokenBalance> {
  const { token } = args;
  const atomic = await readContract(client, {
    address: token.address,
    abi: ERC20_BALANCE_OF,
    functionName: 'balanceOf',
    args: [args.address],
    ...blockArgsOf(args),
  } as Parameters<typeof readContract>[1]) as bigint;
  return {
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    convertible: isConvertible(token),
    atomic,
    formatted: formatUnits(atomic, token.decimals),
  };
}

/**
 * Native and stablecoin balances of one account, each reported separately, plus the
 * aggregate the node reports. One `eth_getBalance`, one `eth_call` per token, and one
 * `eth_call` for the raw native balance, all in parallel.
 */
export async function getBalances(client: BalanceClient, args: GetBalancesParameters): Promise<AccountBalances> {
  const tokens = args.tokens ?? defaultTokens(client, args.network);
  const mode = args.nativeBalance ?? 'auto';
  const block = blockArgsOf(args);
  const nativeCurrency = client.chain?.nativeCurrency ?? radiusMainnet.chain.nativeCurrency;

  type EvmRead = { raw?: bigint; error?: string };
  const readNative = async (): Promise<EvmRead> => {
    if (mode === 'derived') return {};
    try {
      return { raw: await getNativeBalance(client, { address: args.address, ...block }) };
    } catch (e) {
      if (mode === 'evm') throw e;
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const [aggregate, tokenBalances, evm] = await Promise.all([
    getAggregateBalance(client, { address: args.address, ...block }),
    Promise.all(tokens.map((token) => getTokenBalance(client, { address: args.address, token, ...block }))),
    readNative(),
  ]);

  let raw: bigint;
  let rawSource: NativeBalance['rawSource'];
  if (evm.raw !== undefined) {
    raw = evm.raw;
    rawSource = 'evm';
  } else {
    const convertible = tokenBalances.filter((t) => t.convertible).reduce((sum, t) => sum + toWei(t.atomic, t.decimals, nativeCurrency.decimals), 0n);
    raw = aggregate > convertible ? aggregate - convertible : 0n;
    rawSource = 'derived';
  }
  const convertible = aggregate > raw ? aggregate - raw : 0n;
  const fmt = (v: bigint) => formatUnits(v, nativeCurrency.decimals);
  const total = tokenBalances.filter((t) => t.convertible).reduce((sum, t) => sum + toWei(t.atomic, t.decimals, nativeCurrency.decimals), raw);
  return {
    address: args.address,
    native: {
      symbol: nativeCurrency.symbol,
      decimals: nativeCurrency.decimals,
      raw,
      rawFormatted: fmt(raw),
      aggregate,
      aggregateFormatted: fmt(aggregate),
      convertible,
      convertibleFormatted: fmt(convertible),
      rawSource,
      ...(evm.error !== undefined ? { rawError: evm.error } : {}),
    },
    tokens: tokenBalances,
    total,
    totalFormatted: fmt(total),
  };
}

// A type alias, not an interface: viem's `client.extend()` needs the implicit index signature.
export type RadiusActions = {
  /** Native RUSD only (EVM `BALANCE`), in wei. */
  getNativeBalance: (args: GetNativeBalanceParameters) => Promise<bigint>;
  /** `eth_getBalance`: native plus convertible stablecoins, in wei. */
  getAggregateBalance: (args: GetNativeBalanceParameters) => Promise<bigint>;
  /** Raw ERC-20 balance of one token. */
  getTokenBalance: (args: GetTokenBalanceParameters) => Promise<TokenBalance>;
  /** Native, per-token and aggregate balances of one account. */
  getBalances: (args: GetBalancesParameters) => Promise<AccountBalances>;
};

export interface RadiusActionsConfig {
  /** Default tokens for `getBalances` (else chosen from `network` / the client's chain). */
  tokens?: BalanceToken[];
  /** Default network for `getBalances`. */
  network?: NetworkInput;
}

/**
 * viem client extension:
 *
 *   const client = createPublicClient({ chain: radiusTestnet.chain, transport: http() }).extend(radiusActions());
 *   const { native, tokens } = await client.getBalances({ address });
 *   native.raw        // RUSD only
 *   tokens[0].atomic  // SBC only
 *   native.aggregate  // what eth_getBalance / getBalance() reports
 */
export function radiusActions(config: RadiusActionsConfig = {}) {
  return (client: BalanceClient): RadiusActions => ({
    getNativeBalance: (args) => getNativeBalance(client, args),
    getAggregateBalance: (args) => getAggregateBalance(client, args),
    getTokenBalance: (args) => getTokenBalance(client, args),
    getBalances: (args) => getBalances(client, { tokens: config.tokens, network: config.network, ...args }),
  });
}

/** Tokens `getBalances` reads by default: the network's payment asset, marked convertible. */
export function defaultTokens(client: BalanceClient, network?: NetworkInput): BalanceToken[] {
  const asset: RadiusAsset = network !== undefined ? resolveNetwork(network).asset : (radiusNetworkForChainId(client.chain?.id)?.asset ?? SBC);
  return [{ address: asset.address, symbol: asset.symbol, decimals: asset.decimals, convertible: true }];
}

function isConvertible(token: BalanceToken): boolean {
  return token.convertible ?? token.address.toLowerCase() === SBC.address.toLowerCase();
}

/** Rescale a token amount to the native currency's decimals at face value (SBC 10^6 → RUSD 10^18). */
function toWei(atomic: bigint, decimals: number, nativeDecimals: number): bigint {
  if (decimals === nativeDecimals) return atomic;
  if (decimals < nativeDecimals) return atomic * 10n ** BigInt(nativeDecimals - decimals);
  return atomic / 10n ** BigInt(decimals - nativeDecimals);
}
