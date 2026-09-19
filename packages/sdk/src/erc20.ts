/**
 * Common ERC-20 interactions as viem actions: metadata, allowance, approve, transfer,
 * transferFrom, and Transfer-event queries. SBC is the default token on Radius networks.
 *
 * Reads take any viem `Client`; writes take a viem WalletClient (a client with an `account`)
 * and, like `createRadiusFetch().send()`, wait for the receipt: Radius finality is sub-second,
 * so the receipt is the natural unit of work. `erc20Actions()` is a client extension:
 *
 *   const wallet = createWalletClient({ account, chain: radiusTestnet.chain, transport: http() }).extend(erc20Actions());
 *   await wallet.transfer({ to, amount: '1.50' });                    // 1.50 SBC (display units, token decimals)
 *   await wallet.approve({ spender, amount: 2_000_000n });           // atomic units
 *   await wallet.getAllowance({ owner: wallet.account.address, spender });
 *
 * Amounts are either `bigint` atomic units or a decimal string in display units, parsed with
 * the token's `decimals` (fetched on-chain when the token is given as a bare address).
 */

import { erc20Abi, formatUnits, parseUnits, type Account, type Address, type Chain, type Client, type Hex, type Transport } from 'viem';
import { getLogs, readContract, waitForTransactionReceipt, watchContractEvent, writeContract } from 'viem/actions';
import { defaultTokens, type BalanceClient, type BalanceToken } from './balances.js';
import { RadiusPaymentError } from './errors.js';

/** A viem client that can send transactions: `createWalletClient({ account, chain, transport })`. */
export type TokenWalletClient = Client<Transport, Chain | undefined, Account | undefined>;

/** A token by address, or with its decimals/symbol known up front (saves the `decimals()` read). */
export type TokenInput = Address | BalanceToken;

/** `bigint` = atomic units; `string` = display units (e.g. "1.5"), parsed with the token's decimals. */
export type TokenAmount = bigint | string;

export interface TokenMetadata {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export interface TxResult {
  hash: `0x${string}`;
  status: 'success' | 'reverted';
  explorerUrl?: string;
}

export interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  /** Atomic units. */
  amount: bigint;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface GetTokenMetadataParameters {
  token?: TokenInput;
}

export interface GetAllowanceParameters {
  token?: TokenInput;
  owner: Address;
  spender: Address;
}

export interface ApproveParameters {
  token?: TokenInput;
  spender: Address;
  amount: TokenAmount;
  /** Return as soon as the transaction is sent (status reported as `success` unverified). Default: wait for the receipt. */
  wait?: boolean;
}

export interface TransferParameters {
  token?: TokenInput;
  to: Address;
  amount: TokenAmount;
  wait?: boolean;
}

export interface TransferFromParameters {
  token?: TokenInput;
  from: Address;
  to: Address;
  amount: TokenAmount;
  wait?: boolean;
}

export interface GetTransfersParameters {
  token?: TokenInput;
  /** Filter by sender (indexed). */
  from?: Address;
  /** Filter by recipient (indexed). */
  to?: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
}

export interface WatchTransfersParameters {
  token?: TokenInput;
  from?: Address;
  to?: Address;
  onTransfer: (transfer: TokenTransfer) => void;
  onError?: (error: Error) => void;
  /** Poll interval in ms (Radius blocks are timestamps; polling is the transport). */
  pollingInterval?: number;
}

function addressOf(token: TokenInput): Address {
  return typeof token === 'string' ? token : token.address;
}

/** Resolve the token to use: the argument, else the network's payment asset (SBC). */
function resolveToken(client: BalanceClient, token: TokenInput | undefined, fallback?: TokenInput): TokenInput {
  return token ?? fallback ?? defaultTokens(client)[0];
}

async function decimalsOf(client: BalanceClient, token: TokenInput): Promise<number> {
  if (typeof token !== 'string') return token.decimals;
  return readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' });
}

/** Convert a `TokenAmount` to atomic units, reading `decimals()` only when needed. */
export async function toTokenAtomic(client: BalanceClient, token: TokenInput, amount: TokenAmount): Promise<bigint> {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new RadiusPaymentError('config', `Token amount must not be negative (got ${amount})`);
    return amount;
  }
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RadiusPaymentError('config', `Token amount must be a decimal string like "1.5" or a bigint of atomic units (got ${JSON.stringify(amount)})`);
  const decimals = await decimalsOf(client, token);
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) throw new RadiusPaymentError('config', `Token amount ${s} has more than ${decimals} decimal places`);
  return parseUnits(s, decimals);
}

/** `name`, `symbol`, `decimals` and `totalSupply` of a token, read in parallel. */
export async function getTokenMetadata(client: BalanceClient, args: GetTokenMetadataParameters = {}): Promise<TokenMetadata> {
  const address = addressOf(resolveToken(client, args.token));
  const read = <F extends 'name' | 'symbol' | 'decimals' | 'totalSupply'>(functionName: F) =>
    readContract(client, { address, abi: erc20Abi, functionName }) as Promise<F extends 'decimals' ? number : F extends 'totalSupply' ? bigint : string>;
  const [name, symbol, decimals, totalSupply] = await Promise.all([read('name'), read('symbol'), read('decimals'), read('totalSupply')]);
  return { address, name, symbol, decimals, totalSupply };
}

/** ERC-20 `allowance(owner, spender)`, in atomic units. */
export function getAllowance(client: BalanceClient, args: GetAllowanceParameters): Promise<bigint> {
  const address = addressOf(resolveToken(client, args.token));
  return readContract(client, { address, abi: erc20Abi, functionName: 'allowance', args: [args.owner, args.spender] });
}

/** Require an account on the client, else a `config` error naming the action. */
export function requireAccount(client: TokenWalletClient, what: string): Account {
  if (!client.account) {
    throw new RadiusPaymentError('config', `${what} needs a wallet client with an account: createWalletClient({ account, chain, transport })`);
  }
  return client.account;
}

/** Explorer link for a transaction on the client's chain, when it declares an explorer. */
export function explorerUrlFor(client: Client<Transport, Chain | undefined>, hash: Hex): string | undefined {
  const base = client.chain?.blockExplorers?.default.url;
  return base ? `${base.replace(/\/+$/, '')}/tx/${hash}` : undefined;
}

/** Send a transaction through `send`, then (unless `wait: false`) wait for its receipt. */
export async function sendAndWait(client: TokenWalletClient, wait: boolean | undefined, send: () => Promise<Hex>): Promise<TxResult> {
  const hash = await send();
  if (wait === false) return { hash, status: 'success', explorerUrl: explorerUrlFor(client, hash) };
  const receipt = await waitForTransactionReceipt(client, { hash });
  return { hash, status: receipt.status === 'success' ? 'success' : 'reverted', explorerUrl: explorerUrlFor(client, hash) };
}

/** ERC-20 `approve(spender, amount)` from the client's account. */
export async function approve(client: TokenWalletClient, args: ApproveParameters): Promise<TxResult> {
  const account = requireAccount(client, 'approve');
  const token = resolveToken(client, args.token);
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'approve', args: [args.spender, amount], account, chain: client.chain }),
  );
}

/** ERC-20 `transfer(to, amount)` from the client's account. */
export async function transfer(client: TokenWalletClient, args: TransferParameters): Promise<TxResult> {
  const account = requireAccount(client, 'transfer');
  const token = resolveToken(client, args.token);
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'transfer', args: [args.to, amount], account, chain: client.chain }),
  );
}

/** ERC-20 `transferFrom(from, to, amount)`: spend an allowance `from` granted to the client's account. */
export async function transferFrom(client: TokenWalletClient, args: TransferFromParameters): Promise<TxResult> {
  const account = requireAccount(client, 'transferFrom');
  const token = resolveToken(client, args.token);
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'transferFrom', args: [args.from, args.to, amount], account, chain: client.chain }),
  );
}

type TransferLog = { address: Address; args: { from?: Address; to?: Address; value?: bigint }; transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null };

function toTransfer(log: TransferLog): TokenTransfer {
  return {
    token: log.address,
    from: log.args.from as Address,
    to: log.args.to as Address,
    amount: log.args.value as bigint,
    transactionHash: log.transactionHash as Hex,
    blockNumber: log.blockNumber as bigint,
    logIndex: log.logIndex as number,
  };
}

/** Past `Transfer` events of a token, optionally filtered by `from` / `to` and a block range. */
export async function getTransfers(client: BalanceClient, args: GetTransfersParameters = {}): Promise<TokenTransfer[]> {
  const address = addressOf(resolveToken(client, args.token));
  const logs = await getLogs(client, {
    address,
    event: erc20Abi.find((i) => i.type === 'event' && i.name === 'Transfer')!,
    args: { from: args.from, to: args.to },
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    strict: true,
  } as Parameters<typeof getLogs>[1]);
  return (logs as unknown as TransferLog[]).map(toTransfer);
}

/** Subscribe to `Transfer` events of a token. Returns the unwatch function. */
export function watchTransfers(client: BalanceClient, args: WatchTransfersParameters): () => void {
  const address = addressOf(resolveToken(client, args.token));
  return watchContractEvent(client, {
    address,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: args.from, to: args.to },
    strict: true,
    pollingInterval: args.pollingInterval,
    onLogs: (logs) => {
      for (const log of logs as unknown as TransferLog[]) args.onTransfer(toTransfer(log));
    },
    onError: args.onError,
  } as Parameters<typeof watchContractEvent>[1]);
}

/** Display helper: atomic → "1.5 SBC" for a known token. */
export function formatTokenAmount(atomic: bigint, token: BalanceToken): string {
  return `${formatUnits(atomic, token.decimals)} ${token.symbol}`;
}

// A type alias, not an interface: viem's `client.extend()` needs the implicit index signature.
export type Erc20Actions = {
  getTokenMetadata: (args?: GetTokenMetadataParameters) => Promise<TokenMetadata>;
  getAllowance: (args: GetAllowanceParameters) => Promise<bigint>;
  approve: (args: ApproveParameters) => Promise<TxResult>;
  transfer: (args: TransferParameters) => Promise<TxResult>;
  transferFrom: (args: TransferFromParameters) => Promise<TxResult>;
  getTransfers: (args?: GetTransfersParameters) => Promise<TokenTransfer[]>;
  watchTransfers: (args: WatchTransfersParameters) => () => void;
};

export interface Erc20ActionsConfig {
  /** Default token for every action (else the network's payment asset, SBC). */
  token?: TokenInput;
}

/**
 * viem client extension for ERC-20 interactions. Reads work on any client; `approve`,
 * `transfer` and `transferFrom` need a wallet client with an account.
 */
export function erc20Actions(config: Erc20ActionsConfig = {}) {
  return (client: TokenWalletClient): Erc20Actions => {
    const withToken = <T extends { token?: TokenInput }>(args: T): T => ({ ...args, token: args.token ?? config.token });
    return {
      getTokenMetadata: (args = {}) => getTokenMetadata(client, withToken(args)),
      getAllowance: (args) => getAllowance(client, withToken(args)),
      approve: (args) => approve(client, withToken(args)),
      transfer: (args) => transfer(client, withToken(args)),
      transferFrom: (args) => transferFrom(client, withToken(args)),
      getTransfers: (args = {}) => getTransfers(client, withToken(args)),
      watchTransfers: (args) => watchTransfers(client, withToken(args)),
    };
  };
}
