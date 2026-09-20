/**
 * Client for the Radius Swap API (`<swapUrl>/openapi.json` documents it; testnet:
 * https://testnet.radiustech.xyz/api/v1/swap/openapi.json). Moves SBC/USDC between Radius and
 * Base / Ethereum (and their testnets) through Brale.
 *
 * Endpoints (all JSON; protected ones take `Authorization: Bearer <swap_token>`):
 *   GET  /instructions           supported routes (chain ids, token contracts, decimals), agent guide
 *   POST /prepare                signed EIP-712 `SwapIntent` → short-lived unsigned ERC-20 transfer + prepared swap_token
 *   POST /broadcast              the signed transaction, exactly as prepared → durable session + status swap_token
 *   GET  /status                 prepared swap or durable session behind the bearer token
 *   POST /sessions/token         signed EIP-712 `SwapSessionListAccess` → wallet-scoped list swap_token
 *   GET  /sessions               durable sessions and active prepared swaps for that wallet
 *
 * The flow is prepare → sign the returned `unsigned_tx` without changing a field → broadcast →
 * poll status (no more often than every 3 s) until `complete` / `failed` / `expired`. Only one
 * prepared transaction may be active per source wallet and chain; prepared swap_tokens are
 * single-use for broadcast. A source-chain gas balance is needed (the API broadcasts on the
 * caller's behalf but the transfer is the caller's transaction).
 *
 * Errors share the Radius API envelope `{ error: { code, message, request_id, retry_after_ms?,
 * details? } }`. Everything the API returns is treated as data: only documented fields are read
 * and free text is surfaced, never interpreted.
 */

import type { Hex, TypedDataDomain } from 'viem';
import { RadiusPaymentError } from './errors.js';
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from './networks.js';

/** Public chain identifiers the API accepts (the testnet deployment serves the `*_sepolia` / `radius_testnet` ones). */
export type SwapChain = 'base' | 'base_sepolia' | 'ethereum' | 'sepolia' | 'radius' | 'radius_testnet' | (string & {});
export type SwapToken = 'USDC' | 'SBC' | (string & {});
export type SwapEnvironment = 'testnet' | 'mainnet';
/** Durable session lifecycle. */
export type SwapSessionStatus = 'pending_broadcast' | 'pending_deposit' | 'processing' | 'complete' | 'failed' | 'expired';
/** A prepared (not yet broadcast) swap, or a session status. */
export type SwapFlowStatus = 'prepared' | SwapSessionStatus;
export const SWAP_TERMINAL_STATUSES: ReadonlySet<SwapFlowStatus> = new Set<SwapFlowStatus>(['complete', 'failed', 'expired']);

/** Error codes the API documents, plus the client's own. */
export type SwapErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSUPPORTED_TOKEN'
  | 'UNSUPPORTED_ROUTE'
  | 'INVALID_AMOUNT'
  | 'INVALID_SIGNATURE'
  | 'SIGNATURE_EXPIRED'
  | 'IDEMPOTENCY_KEY_ALREADY_USED'
  | 'ACTIVE_PREPARED_TX_EXISTS'
  | 'INVALID_SIGNED_TX'
  | 'TX_RECIPIENT_MISMATCH'
  | 'TX_TOKEN_MISMATCH'
  | 'TX_AMOUNT_MISMATCH'
  | 'INSUFFICIENT_SOURCE_TOKEN'
  | 'INSUFFICIENT_GAS'
  | 'SOURCE_PREFLIGHT_FAILED'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'ADDRESS_BLOCKED'
  | 'TOKEN_SESSION_MISMATCH'
  | 'PREPARED_TX_NOT_FOUND'
  | 'PREPARED_TX_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_ALREADY_BROADCAST'
  | 'SESSION_NOT_CANCELLABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  /** Client-side: the API answered with something that is not the documented JSON. */
  | 'INVALID_RESPONSE'
  /** Client-side: the signer cannot do what the step needs (`signTypedData` / `signTransaction`). */
  | 'SIGNER_REQUIRED'
  /** Client-side: no swap API URL for this network. */
  | 'NO_SWAP_API'
  /** Client-side: `waitForCompletion` gave up before a terminal status. */
  | 'TIMEOUT'
  /** Client-side (`swap()`): the session ended `failed` or `expired`; `details` is the final status. */
  | 'SWAP_FAILED'
  | (string & {});

/**
 * A swap API call failed. `code` is always `'swap'` (so `RadiusPaymentError` handling keeps
 * working); `swapCode` is the API's own code, `requestId` its `X-Request-Id`.
 */
export class SwapError extends RadiusPaymentError {
  readonly swapCode: SwapErrorCode;
  /** HTTP status of the failing response (0 when there was none). */
  readonly status: number;
  readonly requestId?: string;
  /** For `RATE_LIMITED`: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** `error.details`, when the API attached structured context. */
  readonly errorDetails?: Record<string, unknown>;
  constructor(
    swapCode: SwapErrorCode,
    message: string,
    opts: { status?: number; requestId?: string; retryAfterMs?: number; errorDetails?: Record<string, unknown>; details?: unknown } = {},
  ) {
    super('swap', message, opts.details);
    this.name = 'SwapError';
    this.swapCode = swapCode;
    this.status = opts.status ?? 0;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.errorDetails !== undefined) this.errorDetails = opts.errorDetails;
  }
}

/** One supported route, from `GET /instructions`. */
export interface SwapRoute {
  sourceChain: SwapChain;
  sourceToken: SwapToken;
  destinationChain: SwapChain;
  destinationToken: SwapToken;
  /** EVM chain id of the source chain: the EIP-712 domain `chainId` for the intent. */
  sourceChainId: number;
  sourceTokenContract: Address;
  sourceTokenDecimals: number;
  destinationChainId: number;
  destinationTokenContract: Address;
  destinationTokenDecimals: number;
}

export interface SwapRouteSelector {
  sourceChain: SwapChain;
  sourceToken: SwapToken;
  destinationChain: SwapChain;
  destinationToken: SwapToken;
}

/** `GET /instructions`. */
export interface SwapInstructions {
  version: string;
  /** The value to put in the EIP-712 `environment` field. */
  environment: SwapEnvironment;
  overview: string;
  routes: SwapRoute[];
  /** Step-by-step agent guide, verbatim. */
  steps: unknown[];
  importantRules: string[];
  errorCodes: { code: SwapErrorCode; description: string; callerAction: string }[];
  raw: unknown;
}

/** What to swap. Addresses default to the signer; `amount` is a decimal string in source-token units ("12.5"). */
export interface SwapIntent extends SwapRouteSelector {
  /** Wallet that holds the source token and signs; defaults to the signer's address. */
  sourceAddress?: Address;
  /** Recipient on the destination chain; defaults to `sourceAddress`. */
  destinationAddress?: Address;
  /** Decimal amount as a string, e.g. "100.00" (signed as-is, so no float formatting). */
  amount: string;
  /** Unique per intent; defaults to `idem_<random>`. A deterministic preflight failure consumes it. */
  idempotencyKey?: string;
  /** Unix seconds (or a Date) until which the signed intent is valid; defaults to now + 300 s. */
  expiresAt?: number | Date;
}

/** `POST /prepare` body: a `SwapIntent` with every default applied, plus its signature. */
export interface PrepareSwapRequest {
  source_chain: SwapChain;
  source_token: SwapToken;
  destination_chain: SwapChain;
  destination_token: SwapToken;
  source_address: Address;
  destination_address: Address;
  amount: string;
  idempotency_key: string;
  expires_at: number;
  signature: Hex;
}

export const SWAP_INTENT_TYPES = {
  SwapIntent: [
    { name: 'sourceAddress', type: 'address' },
    { name: 'sourceChain', type: 'string' },
    { name: 'sourceToken', type: 'string' },
    { name: 'destinationChain', type: 'string' },
    { name: 'destinationToken', type: 'string' },
    { name: 'destinationAddress', type: 'address' },
    { name: 'amount', type: 'string' },
    { name: 'idempotencyKey', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'environment', type: 'string' },
  ],
} as const;

export const SWAP_SESSION_LIST_ACCESS_TYPES = {
  SwapSessionListAccess: [
    { name: 'sourceAddress', type: 'address' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'environment', type: 'string' },
  ],
} as const;

export const SWAP_TYPED_DATA_DOMAIN = { name: 'Radius Swap API', version: '1' } as const;

export interface SwapIntentTypedData {
  domain: TypedDataDomain & { name: 'Radius Swap API'; version: '1'; chainId: number };
  types: typeof SWAP_INTENT_TYPES;
  primaryType: 'SwapIntent';
  message: {
    sourceAddress: Address;
    sourceChain: string;
    sourceToken: string;
    destinationChain: string;
    destinationToken: string;
    destinationAddress: Address;
    amount: string;
    idempotencyKey: string;
    expiresAt: bigint;
    environment: string;
  };
}

export interface SwapSessionListAccessTypedData {
  domain: TypedDataDomain & { name: 'Radius Swap API'; version: '1' };
  types: typeof SWAP_SESSION_LIST_ACCESS_TYPES;
  primaryType: 'SwapSessionListAccess';
  message: { sourceAddress: Address; expiresAt: bigint; environment: string };
}

/** Build the EIP-712 payload `POST /prepare` verifies. `sourceChainId` is the route's (see `SwapRoute`). */
export function swapIntentTypedData(request: Omit<PrepareSwapRequest, 'signature'>, sourceChainId: number, environment: SwapEnvironment): SwapIntentTypedData {
  return {
    domain: { ...SWAP_TYPED_DATA_DOMAIN, chainId: sourceChainId },
    types: SWAP_INTENT_TYPES,
    primaryType: 'SwapIntent',
    message: {
      sourceAddress: request.source_address,
      sourceChain: request.source_chain,
      sourceToken: request.source_token,
      destinationChain: request.destination_chain,
      destinationToken: request.destination_token,
      destinationAddress: request.destination_address,
      amount: request.amount,
      idempotencyKey: request.idempotency_key,
      expiresAt: BigInt(request.expires_at),
      environment,
    },
  };
}

/** Build the EIP-712 payload `POST /sessions/token` verifies (no chainId in the domain). */
export function swapSessionListAccessTypedData(sourceAddress: Address, expiresAt: number, environment: SwapEnvironment): SwapSessionListAccessTypedData {
  return {
    domain: { ...SWAP_TYPED_DATA_DOMAIN },
    types: SWAP_SESSION_LIST_ACCESS_TYPES,
    primaryType: 'SwapSessionListAccess',
    message: { sourceAddress, expiresAt: BigInt(expiresAt), environment },
  };
}

/** The prepared ERC-20 transfer, as returned: hex quantities (JSON carries no bigint). Sign it exactly as is. */
export interface UnsignedSwapTransaction {
  to: Address;
  data: Hex;
  value: Hex;
  chainId: number;
  type: 'legacy';
  nonce: Hex;
  gas: Hex;
  gasPrice: Hex;
}

/** `UnsignedSwapTransaction` with the quantities decoded: what viem's `signTransaction` takes. */
export interface SignableSwapTransaction {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  type: 'legacy';
  nonce: number;
  gas: bigint;
  gasPrice: bigint;
}

/** Decode the hex quantities of a prepared transaction for signing. Changes no value. */
export function toSignableTransaction(tx: UnsignedSwapTransaction): SignableSwapTransaction {
  return { to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId, type: 'legacy', nonce: Number(BigInt(tx.nonce)), gas: BigInt(tx.gas), gasPrice: BigInt(tx.gasPrice) };
}

/** `POST /prepare` success. */
export interface PreparedSwap {
  /** Prepared-scope token: `Authorization: Bearer` for `broadcast()` and `status()`. Single-use for broadcast. */
  swapToken: string;
  swapTokenExpiresAt: Date;
  /** After this the prepared transaction is gone; prepare again. */
  preparedTxExpiresAt: Date;
  depositAddress: Address;
  depositTokenAddress: Address;
  depositChain: SwapChain;
  depositToken: SwapToken;
  destinationChain: SwapChain;
  destinationToken: SwapToken;
  payoutTokenAddress: Address;
  amount: string;
  unsignedTx: UnsignedSwapTransaction;
  raw: unknown;
}

/** `POST /broadcast` success. */
export interface SwapBroadcast {
  sessionId: string;
  /** Session-status token for `status()` (short-lived; recover via `sessionListToken()` + `listSessions()`). */
  swapToken: string;
  swapTokenExpiresAt: Date;
  /** Source-chain transaction hash. */
  txHash: Hex;
  status: SwapSessionStatus;
  raw: unknown;
}

/** `GET /status`, and each item of `GET /sessions`. */
export interface SwapStatus {
  /** `prepared`: still only in the API's short-lived store; `session`: durable. */
  kind: 'prepared' | 'session';
  sessionId?: string;
  status: SwapFlowStatus;
  sourceChain?: SwapChain;
  sourceToken?: SwapToken;
  sourceAddress?: Address;
  destinationAddress?: Address;
  destinationChain?: SwapChain;
  destinationToken?: SwapToken;
  depositAddress?: Address;
  depositTokenAddress?: Address;
  payoutTokenAddress?: Address;
  amount?: string;
  /** Prepared swaps only: broadcast this without preparing again. */
  unsignedTx?: UnsignedSwapTransaction;
  preparedTxExpiresAt?: Date;
  /** A fresh token scoped to this item, when the API issued one (prepared items in listings, statuses). */
  swapToken?: string;
  swapTokenExpiresAt?: Date;
  /** Source-chain deposit transaction. */
  txHash?: Hex;
  /** Destination-chain payout transaction; may appear shortly after `complete`. */
  payoutTx?: Hex;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  /** Why a session `failed`. */
  error?: { code: SwapErrorCode; message: string; requestId?: string };
  raw: unknown;
}

export interface SwapSessionList {
  items: SwapStatus[];
  /** Pass as `cursor` to fetch the next page. */
  nextCursor?: string;
  raw: unknown;
}

export interface ListSessionsQuery {
  /** Durable sessions per page; default 25, max 100. */
  limit?: number;
  cursor?: string;
  /** `prepared` returns only active prepared swaps. */
  status?: SwapFlowStatus;
  sourceChain?: SwapChain;
  /** Source transaction hash of a durable session. */
  txHash?: Hex;
}

/**
 * The source wallet: a viem local account (`privateKeyToAccount`) has everything. `signTransaction`
 * is needed for `swap()`; injected browser wallets (MetaMask) do not offer it, so they can `prepare()`
 * but must broadcast the prepared transaction another way.
 */
export interface SwapSigner {
  address: Address;
  signTypedData(typedData: SwapIntentTypedData | SwapSessionListAccessTypedData): Promise<Hex>;
  signTransaction?(transaction: SignableSwapTransaction): Promise<Hex>;
}

export interface WaitForSwapOptions {
  /** Poll interval; the API asks for at least 3 s, which is also the floor here. Default 3000. */
  intervalMs?: number;
  /** Give up (`TIMEOUT`) after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Keep polling a `complete` session until `payoutTx` is present (proof of delivery). */
  untilPayout?: boolean;
  /** Called after every poll. */
  onStatus?: (status: SwapStatus) => void;
}

export interface SwapResult {
  prepared: PreparedSwap;
  broadcast: SwapBroadcast;
  /** Final status when `wait` was on. */
  status?: SwapStatus;
}

export interface SwapClientOptions extends NetworkOverrides {
  /** Which deployment: 'mainnet' (default), 'testnet', a preset, or a custom network with `swapUrl`. */
  network?: NetworkInput;
  /** Swap API base URL; overrides the network's (`swapUrl` from `NetworkOverrides` is an alias). */
  url?: string;
  /** EIP-712 `environment`; defaults to the network's (testnet → 'testnet'), else `GET /instructions`. */
  environment?: SwapEnvironment;
  /** Underlying fetch (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export interface SwapClient {
  /** Base URL without trailing slash, e.g. https://testnet.radiustech.xyz/api/v1/swap */
  readonly url: string;
  readonly network?: RadiusNetwork;
  /** `GET /instructions`; cached after the first call. */
  instructions(): Promise<SwapInstructions>;
  /** Supported routes (from `instructions()`). */
  routes(): Promise<SwapRoute[]>;
  /** The route matching a selector, or `UNSUPPORTED_ROUTE`. */
  route(selector: SwapRouteSelector): Promise<SwapRoute>;
  /** The EIP-712 `environment` this client signs with. */
  environment(): Promise<SwapEnvironment>;
  /** Fill in defaults, sign the `SwapIntent` with `signer`, and `POST /prepare`. */
  prepare(intent: SwapIntent, signer: SwapSigner): Promise<PreparedSwap>;
  /** `POST /prepare` with an intent signed elsewhere (see `swapIntentTypedData`). */
  prepareSigned(request: PrepareSwapRequest): Promise<PreparedSwap>;
  /** Sign `prepared.unsignedTx` exactly as returned with `signer.signTransaction`. */
  signPrepared(prepared: Pick<PreparedSwap, 'unsignedTx'>, signer: SwapSigner): Promise<Hex>;
  /** `POST /broadcast` the signed transaction under the prepared swap token. */
  broadcast(swapToken: string, signedTx: Hex): Promise<SwapBroadcast>;
  /** `GET /status` for a prepared or session-status token. */
  status(swapToken: string): Promise<SwapStatus>;
  /** Poll `status()` until a terminal status (or `untilPayout`). */
  waitForCompletion(swapToken: string, options?: WaitForSwapOptions): Promise<SwapStatus>;
  /** Sign `SwapSessionListAccess` and `POST /sessions/token` for a wallet-scoped list token. */
  sessionListToken(signer: SwapSigner, options?: { expiresAt?: number | Date }): Promise<{ swapToken: string; swapTokenExpiresAt: Date; raw: unknown }>;
  /** `GET /sessions` under a list token. */
  listSessions(swapToken: string, query?: ListSessionsQuery): Promise<SwapSessionList>;
  /**
   * prepare → sign → broadcast, then (default) wait for a terminal status. Throws `SWAP_FAILED`
   * when the session ends `failed` or `expired`.
   */
  swap(intent: SwapIntent, signer: SwapSigner, options?: { wait?: boolean | WaitForSwapOptions }): Promise<SwapResult>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const AMOUNT = /^\d+(\.\d+)?$/;
const DEFAULT_INTENT_TTL_SECONDS = 300;
const MIN_POLL_MS = 3000;

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: JsonObject, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
const num = (o: JsonObject, k: string): number | undefined => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : undefined);
const addr = (o: JsonObject, k: string): Address | undefined => {
  const v = str(o, k);
  return v && ADDRESS.test(v) ? (v as Address) : undefined;
};
const hash = (o: JsonObject, k: string): Hex | undefined => {
  const v = str(o, k);
  return v && TX_HASH.test(v) ? (v as Hex) : undefined;
};
const date = (o: JsonObject, k: string): Date | undefined => {
  const v = str(o, k);
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const unix = (v: number | Date | undefined, fallbackTtl: number): number => {
  if (v === undefined) return Math.floor(Date.now() / 1000) + fallbackTtl;
  const n = v instanceof Date ? Math.floor(v.getTime() / 1000) : Math.floor(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new SwapError('INVALID_REQUEST', `expiresAt must be a Unix timestamp in seconds or a Date (got ${String(v)})`);
  return n;
};
const randomKey = (): string => {
  const c = globalThis.crypto as { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined;
  if (c?.randomUUID) return `idem_${c.randomUUID().replaceAll('-', '')}`;
  const bytes = c?.getRandomValues ? c.getRandomValues(new Uint8Array(16)) : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  return `idem_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

function readUnsignedTx(v: unknown): UnsignedSwapTransaction | undefined {
  if (!isObject(v)) return undefined;
  const to = addr(v, 'to');
  const data = str(v, 'data');
  const value = str(v, 'value');
  const nonce = str(v, 'nonce');
  const gas = str(v, 'gas');
  const gasPrice = str(v, 'gasPrice');
  const chainId = num(v, 'chainId');
  if (!to || !data || !value || !nonce || !gas || !gasPrice || chainId === undefined || v.type !== 'legacy') return undefined;
  if (![data, value, nonce, gas, gasPrice].every((h) => HEX.test(h))) return undefined;
  return { to, data: data as Hex, value: value as Hex, chainId, type: 'legacy', nonce: nonce as Hex, gas: gas as Hex, gasPrice: gasPrice as Hex };
}

function readStatus(o: JsonObject): SwapStatus {
  const kind = o.kind === 'prepared' || o.kind === 'session' ? o.kind : undefined;
  const status = str(o, 'status') as SwapFlowStatus | undefined;
  if (!kind || !status) throw new SwapError('INVALID_RESPONSE', 'Swap status is missing kind/status', { details: o });
  const out: SwapStatus = { kind, status, raw: o };
  const set = <K extends keyof SwapStatus>(k: K, v: SwapStatus[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('sessionId', str(o, 'session_id'));
  set('sourceChain', str(o, 'source_chain'));
  set('sourceToken', str(o, 'source_token'));
  set('sourceAddress', addr(o, 'source_address'));
  set('destinationAddress', addr(o, 'destination_address'));
  set('destinationChain', str(o, 'destination_chain'));
  set('destinationToken', str(o, 'destination_token'));
  set('depositAddress', addr(o, 'deposit_address'));
  set('depositTokenAddress', addr(o, 'deposit_token_address'));
  set('payoutTokenAddress', addr(o, 'payout_token_address'));
  set('amount', str(o, 'amount'));
  set('unsignedTx', readUnsignedTx(o.unsigned_tx));
  set('preparedTxExpiresAt', date(o, 'prepared_tx_expires_at'));
  set('swapToken', str(o, 'swap_token'));
  set('swapTokenExpiresAt', date(o, 'swap_token_expires_at'));
  set('txHash', hash(o, 'tx_hash'));
  set('payoutTx', hash(o, 'payout_tx'));
  set('createdAt', date(o, 'created_at'));
  set('updatedAt', date(o, 'updated_at'));
  set('completedAt', date(o, 'completed_at'));
  if (isObject(o.error)) {
    const e = o.error;
    const code = str(e, 'code');
    if (code) out.error = { code, message: str(e, 'message') ?? '', requestId: str(e, 'request_id') };
  }
  return out;
}

function readRoute(v: unknown): SwapRoute | undefined {
  if (!isObject(v)) return undefined;
  const r = {
    sourceChain: str(v, 'source_chain'),
    sourceToken: str(v, 'source_token'),
    destinationChain: str(v, 'destination_chain'),
    destinationToken: str(v, 'destination_token'),
    sourceChainId: num(v, 'source_chain_id'),
    sourceTokenContract: addr(v, 'source_token_contract'),
    sourceTokenDecimals: num(v, 'source_token_decimals'),
    destinationChainId: num(v, 'destination_chain_id'),
    destinationTokenContract: addr(v, 'destination_token_contract'),
    destinationTokenDecimals: num(v, 'destination_token_decimals'),
  };
  return Object.values(r).every((x) => x !== undefined) ? (r as SwapRoute) : undefined;
}

export function createSwapClient(options: SwapClientOptions = {}): SwapClient {
  const { url: urlOption, environment: envOption, fetch: fetchOption, network: networkOption, ...overrides } = options;
  const hasOverrides = Object.values(overrides).some((v) => v !== undefined);
  const network = urlOption && networkOption === undefined && !hasOverrides ? undefined : resolveNetwork(networkOption, hasOverrides ? overrides : undefined);
  const base = urlOption ?? network?.swapUrl;
  if (!base) throw new SwapError('NO_SWAP_API', `No swap API configured for network ${network?.name ?? '(unknown)'}; pass { url } or a network with swapUrl`);
  const url = base.replace(/\/+$/, '');
  const doFetch = fetchOption ?? globalThis.fetch.bind(globalThis);

  const call = async (path: string, init: RequestInit & { token?: string } = {}): Promise<JsonObject> => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = { accept: 'application/json', ...(rest.headers as Record<string, string> | undefined) };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(`${url}${path}`, { ...rest, headers });
    } catch (e) {
      throw new SwapError('INVALID_RESPONSE', `Swap API unreachable at ${url}: ${(e as Error).message}`, { details: e });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // Only the HTTP status decides: a 200 status response legitimately carries `error` (why a session failed).
    if (!res.ok) {
      const err = isObject(body) && isObject(body.error) ? body.error : {};
      const code = str(err, 'code') ?? (res.status === 429 ? 'RATE_LIMITED' : res.status === 404 ? 'NOT_FOUND' : res.status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_RESPONSE');
      const message = str(err, 'message');
      const requestId = str(err, 'request_id') ?? res.headers.get('x-request-id') ?? undefined;
      let retryAfterMs = num(err, 'retry_after_ms');
      if (retryAfterMs === undefined) {
        const h = Number(res.headers.get('retry-after'));
        if (Number.isFinite(h) && h > 0) retryAfterMs = h * 1000;
      }
      const detail = message ? `: ${message}` : body === undefined && text ? `: ${text.slice(0, 200)}` : '';
      const wait = retryAfterMs !== undefined ? ` (retry in ${Math.ceil(retryAfterMs / 1000)} s)` : '';
      const ref = requestId ? ` [${requestId}]` : '';
      throw new SwapError(code, `Swap API ${code} (HTTP ${res.status})${detail}${wait}${ref}`, { status: res.status, requestId, retryAfterMs, errorDetails: isObject(err.details) ? err.details : undefined, details: body ?? text });
    }
    if (!isObject(body)) throw new SwapError('INVALID_RESPONSE', `Swap API returned non-JSON (HTTP ${res.status}) from ${path}`, { status: res.status, details: text });
    return body;
  };

  let instructionsCache: Promise<SwapInstructions> | undefined;
  const instructions = (): Promise<SwapInstructions> => {
    if (instructionsCache) return instructionsCache;
    const pending: Promise<SwapInstructions> = call('/instructions')
      .then((raw): SwapInstructions => {
        const environment = raw.environment;
        if (environment !== 'testnet' && environment !== 'mainnet') throw new SwapError('INVALID_RESPONSE', 'Swap instructions name no environment', { details: raw });
        const routes = Array.isArray(raw.supported_routes) ? raw.supported_routes.map(readRoute).filter((r): r is SwapRoute => r !== undefined) : [];
        const codes = Array.isArray(raw.error_codes) ? raw.error_codes.filter(isObject) : [];
        return {
          version: str(raw, 'version') ?? '',
          environment,
          overview: str(raw, 'overview') ?? '',
          routes,
          steps: Array.isArray(raw.steps) ? raw.steps : [],
          importantRules: Array.isArray(raw.important_rules) ? raw.important_rules.filter((r): r is string => typeof r === 'string') : [],
          errorCodes: codes.map((c) => ({ code: str(c, 'code') ?? '', description: str(c, 'description') ?? '', callerAction: str(c, 'caller_action') ?? '' })),
          raw,
        };
      })
      .catch((e) => {
        instructionsCache = undefined;
        throw e;
      });
    instructionsCache = pending;
    return pending;
  };
  const routes = async () => (await instructions()).routes;
  const route = async (s: SwapRouteSelector): Promise<SwapRoute> => {
    const all = await routes();
    const found = all.find((r) => r.sourceChain === s.sourceChain && r.sourceToken === s.sourceToken && r.destinationChain === s.destinationChain && r.destinationToken === s.destinationToken);
    if (found) return found;
    const offered = all.map((r) => `${r.sourceChain}/${r.sourceToken} → ${r.destinationChain}/${r.destinationToken}`).join(', ') || 'none';
    throw new SwapError('UNSUPPORTED_ROUTE', `No route ${s.sourceChain}/${s.sourceToken} → ${s.destinationChain}/${s.destinationToken}; supported: ${offered}`, { details: all });
  };
  const environment = async (): Promise<SwapEnvironment> => envOption ?? (network ? (network.testnet ? 'testnet' : 'mainnet') : (await instructions()).environment);

  const requireAddress = (v: string | undefined, what: string): Address => {
    if (!v || !ADDRESS.test(v)) throw new SwapError('INVALID_REQUEST', `${what} is not a 0x address (got ${String(v)})`);
    return v as Address;
  };

  const readPrepared = (raw: JsonObject): PreparedSwap => {
    const unsignedTx = readUnsignedTx(raw.unsigned_tx);
    const swapToken = str(raw, 'swap_token');
    const swapTokenExpiresAt = date(raw, 'swap_token_expires_at');
    const preparedTxExpiresAt = date(raw, 'prepared_tx_expires_at');
    const depositAddress = addr(raw, 'deposit_address');
    if (!unsignedTx || !swapToken || !swapTokenExpiresAt || !preparedTxExpiresAt || !depositAddress) {
      throw new SwapError('INVALID_RESPONSE', 'Prepare response is missing swap_token, expiry or unsigned_tx', { details: raw });
    }
    return {
      swapToken,
      swapTokenExpiresAt,
      preparedTxExpiresAt,
      depositAddress,
      depositTokenAddress: addr(raw, 'deposit_token_address') ?? unsignedTx.to,
      depositChain: str(raw, 'deposit_chain') ?? '',
      depositToken: str(raw, 'deposit_token') ?? '',
      destinationChain: str(raw, 'destination_chain') ?? '',
      destinationToken: str(raw, 'destination_token') ?? '',
      payoutTokenAddress: addr(raw, 'payout_token_address') ?? ('0x0000000000000000000000000000000000000000' as Address),
      amount: str(raw, 'amount') ?? '',
      unsignedTx,
      raw,
    };
  };

  const prepareSigned = async (request: PrepareSwapRequest): Promise<PreparedSwap> => {
    const raw = await call('/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    return readPrepared(raw);
  };

  const prepare = async (intent: SwapIntent, signer: SwapSigner): Promise<PreparedSwap> => {
    if (typeof signer?.signTypedData !== 'function') throw new SwapError('SIGNER_REQUIRED', 'prepare() needs a signer with signTypedData (EIP-712), e.g. a viem local account');
    if (typeof intent.amount !== 'string' || !AMOUNT.test(intent.amount)) throw new SwapError('INVALID_AMOUNT', `amount must be a decimal string like "12.5" (got ${JSON.stringify(intent.amount)})`);
    const r = await route(intent);
    const env = await environment();
    const sourceAddress = requireAddress(intent.sourceAddress ?? signer.address, 'sourceAddress');
    const unsigned: Omit<PrepareSwapRequest, 'signature'> = {
      source_chain: r.sourceChain,
      source_token: r.sourceToken,
      destination_chain: r.destinationChain,
      destination_token: r.destinationToken,
      source_address: sourceAddress,
      destination_address: requireAddress(intent.destinationAddress ?? sourceAddress, 'destinationAddress'),
      amount: intent.amount,
      idempotency_key: intent.idempotencyKey ?? randomKey(),
      expires_at: unix(intent.expiresAt, DEFAULT_INTENT_TTL_SECONDS),
    };
    const signature = await signer.signTypedData(swapIntentTypedData(unsigned, r.sourceChainId, env));
    return prepareSigned({ ...unsigned, signature });
  };

  const signPrepared = async (prepared: Pick<PreparedSwap, 'unsignedTx'>, signer: SwapSigner): Promise<Hex> => {
    if (typeof signer?.signTransaction !== 'function') {
      throw new SwapError('SIGNER_REQUIRED', 'Signing the prepared transaction needs a signer with signTransaction (a private key or viem local account); injected wallets cannot');
    }
    return signer.signTransaction(toSignableTransaction(prepared.unsignedTx));
  };

  const broadcast = async (swapToken: string, signedTx: Hex): Promise<SwapBroadcast> => {
    if (!HEX.test(signedTx)) throw new SwapError('INVALID_SIGNED_TX', 'signedTx must be 0x-prefixed hex');
    const raw = await call('/broadcast', { method: 'POST', token: swapToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_tx: signedTx }) });
    const sessionId = str(raw, 'session_id');
    const token = str(raw, 'swap_token');
    const expires = date(raw, 'swap_token_expires_at');
    const txHash = hash(raw, 'tx_hash');
    const status = str(raw, 'status') as SwapSessionStatus | undefined;
    if (!sessionId || !token || !expires || !txHash || !status) throw new SwapError('INVALID_RESPONSE', 'Broadcast response is missing session_id, swap_token, tx_hash or status', { details: raw });
    return { sessionId, swapToken: token, swapTokenExpiresAt: expires, txHash, status, raw };
  };

  const status = async (swapToken: string): Promise<SwapStatus> => readStatus(await call('/status', { token: swapToken }));

  const waitForCompletion = async (swapToken: string, opts: WaitForSwapOptions = {}): Promise<SwapStatus> => {
    const interval = Math.max(opts.intervalMs ?? MIN_POLL_MS, MIN_POLL_MS);
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    let last: SwapStatus | undefined;
    for (;;) {
      last = await status(swapToken);
      opts.onStatus?.(last);
      const done = SWAP_TERMINAL_STATUSES.has(last.status) && !(opts.untilPayout && last.status === 'complete' && !last.payoutTx);
      if (done) return last;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SwapError('TIMEOUT', `Swap ${last.sessionId ?? ''} still ${last.status} after ${opts.timeoutMs ?? 600_000} ms`, { details: last });
      await new Promise((r) => setTimeout(r, Math.min(interval, remaining)));
    }
  };

  const sessionListToken = async (signer: SwapSigner, opts: { expiresAt?: number | Date } = {}) => {
    if (typeof signer?.signTypedData !== 'function') throw new SwapError('SIGNER_REQUIRED', 'sessionListToken() needs a signer with signTypedData (EIP-712)');
    const sourceAddress = requireAddress(signer.address, 'signer.address');
    const expiresAt = unix(opts.expiresAt, DEFAULT_INTENT_TTL_SECONDS);
    const signature = await signer.signTypedData(swapSessionListAccessTypedData(sourceAddress, expiresAt, await environment()));
    const raw = await call('/sessions/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_address: sourceAddress, expires_at: expiresAt, signature }) });
    const swapToken = str(raw, 'swap_token');
    const swapTokenExpiresAt = date(raw, 'swap_token_expires_at');
    if (!swapToken || !swapTokenExpiresAt) throw new SwapError('INVALID_RESPONSE', 'Session list token response is missing swap_token', { details: raw });
    return { swapToken, swapTokenExpiresAt, raw };
  };

  const listSessions = async (swapToken: string, query: ListSessionsQuery = {}): Promise<SwapSessionList> => {
    const q = new URLSearchParams();
    if (query.limit !== undefined) q.set('limit', String(query.limit));
    if (query.cursor) q.set('cursor', query.cursor);
    if (query.status) q.set('status', query.status);
    if (query.sourceChain) q.set('source_chain', query.sourceChain);
    if (query.txHash) q.set('tx_hash', query.txHash);
    const qs = q.toString();
    const raw = await call(`/sessions${qs ? `?${qs}` : ''}`, { token: swapToken });
    if (!Array.isArray(raw.items)) throw new SwapError('INVALID_RESPONSE', 'Session list has no items[]', { details: raw });
    const out: SwapSessionList = { items: raw.items.filter(isObject).map(readStatus), raw };
    const next = str(raw, 'next_cursor');
    if (next) out.nextCursor = next;
    return out;
  };

  const swap = async (intent: SwapIntent, signer: SwapSigner, opts: { wait?: boolean | WaitForSwapOptions } = {}): Promise<SwapResult> => {
    if (typeof signer?.signTransaction !== 'function') {
      throw new SwapError('SIGNER_REQUIRED', 'swap() needs a signer with signTypedData and signTransaction (a private key or viem local account); use prepare() with other signers');
    }
    const prepared = await prepare(intent, signer);
    const signed = await signPrepared(prepared, signer);
    const done = await broadcast(prepared.swapToken, signed);
    if (opts.wait === false) return { prepared, broadcast: done };
    const final = await waitForCompletion(done.swapToken, typeof opts.wait === 'object' ? opts.wait : {});
    if (final.status === 'failed' || final.status === 'expired') {
      throw new SwapError('SWAP_FAILED', `Swap ${final.sessionId ?? done.sessionId} ${final.status}${final.error ? `: ${final.error.code} ${final.error.message}` : ''}`, { details: final });
    }
    return { prepared, broadcast: done, status: final };
  };

  return { url, network, instructions, routes, route, environment, prepare, prepareSigned, signPrepared, broadcast, status, waitForCompletion, sessionListToken, listSessions, swap };
}
