/**
 * Client for the Radius Swap API (`<swapUrl>/openapi.json` documents it; testnet:
 * https://testnet.radiustech.xyz/api/v1/swap/openapi.json). Moves SBC/USDC between Radius and
 * Base / Ethereum (and their testnets) through Brale. Wire types come from `src/generated/swap.ts`,
 * generated from `specs/swap.openapi.json`; this file is the hand-written flow on top and is what
 * breaks when the spec changes incompatibly.
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
import type { components as SwapApi, paths as SwapPaths } from './generated/swap.js';
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from './networks.js';
import type { AssertAssignable, ErrorDetailsOf, JsonBody, JsonOk, Query } from './openapi.js';

// ---- wire contract (generated from specs/swap.openapi.json; see src/openapi.ts) ------------------
// Each operation this client speaks, by path: a renamed or removed endpoint fails to compile here.
type InstructionsOp = SwapPaths['/api/v1/swap/instructions']['get'];
type PrepareOp = SwapPaths['/api/v1/swap/prepare']['post'];
type BroadcastOp = SwapPaths['/api/v1/swap/broadcast']['post'];
type StatusOp = SwapPaths['/api/v1/swap/status']['get'];
type SessionListTokenOp = SwapPaths['/api/v1/swap/sessions/token']['post'];
type ListSessionsOp = SwapPaths['/api/v1/swap/sessions']['get'];
/** Wire shapes, as the swap API documents them. */
export type SwapApiSchemas = SwapApi['schemas'];
type InstructionsResponse = JsonOk<InstructionsOp>;
type PrepareRequestWire = JsonBody<PrepareOp>;
type PrepareResponse = JsonOk<PrepareOp>;
type BroadcastRequestWire = JsonBody<BroadcastOp>;
type BroadcastResponse = JsonOk<BroadcastOp>;
type StatusResponse = JsonOk<StatusOp>;
type SessionListTokenRequestWire = JsonBody<SessionListTokenOp>;
type SessionListTokenResponse = JsonOk<SessionListTokenOp>;
type ListSessionsQuery = Query<ListSessionsOp>;
type ListSessionsResponse = JsonOk<ListSessionsOp>;
type ErrorEnvelope = ErrorDetailsOf<SwapApiSchemas['SwapErrorResponse']>;
type SupportedRoute = SwapApiSchemas['SupportedSwapRoute'];

/** Public chain identifiers the API accepts (from the spec; the testnet deployment serves the `*_sepolia` / `radius_testnet` ones). */
export type SwapChain = SupportedRoute['source_chain'];
export type SwapToken = SupportedRoute['source_token'];
export type SwapEnvironment = InstructionsResponse['environment'];
/** Durable session lifecycle (from the spec). */
export type SwapSessionStatus = BroadcastResponse['status'];
/** A prepared (not yet broadcast) swap, or a session status (from the spec). */
export type SwapFlowStatus = StatusResponse['status'];
export const SWAP_TERMINAL_STATUSES: ReadonlySet<SwapFlowStatus> = new Set<SwapFlowStatus>(['complete', 'failed', 'expired']);
/** Error codes the swap API documents (from the spec). */
export type SwapApiErrorCode = ErrorEnvelope['code'];

/**
 * `SwapApiErrorCode` plus the client's own codes. Kept open (`string`) so a code newer than this
 * SDK passes through untouched.
 */
export type SwapErrorCode =
  | SwapApiErrorCode
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
type _PrepareRequestMatchesSpec = AssertAssignable<PrepareSwapRequest, PrepareRequestWire>;

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
type _UnsignedTxMatchesSpec = AssertAssignable<UnsignedSwapTransaction, SwapApiSchemas['UnsignedSwapTransaction']>;

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

export interface ListSessionsOptions {
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
  listSessions(swapToken: string, query?: ListSessionsOptions): Promise<SwapSessionList>;
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
  const w = v as Partial<SwapApiSchemas['UnsignedSwapTransaction']>;
  const to = addr(v, 'to');
  const data = typeof w.data === 'string' ? w.data : undefined;
  const value = typeof w.value === 'string' ? w.value : undefined;
  const nonce = typeof w.nonce === 'string' ? w.nonce : undefined;
  const gas = typeof w.gas === 'string' ? w.gas : undefined;
  const gasPrice = typeof w.gasPrice === 'string' ? w.gasPrice : undefined;
  const chainId = typeof w.chainId === 'number' && Number.isFinite(w.chainId) ? w.chainId : undefined;
  if (!to || !data || !value || !nonce || !gas || !gasPrice || chainId === undefined || w.type !== 'legacy') return undefined;
  if (![data, value, nonce, gas, gasPrice].every((h) => HEX.test(h))) return undefined;
  return { to, data: data as Hex, value: value as Hex, chainId, type: 'legacy', nonce: nonce as Hex, gas: gas as Hex, gasPrice: gasPrice as Hex };
}

/** A key of the wire status whose value the spec types as a string. */
type StatusStringKey = { [K in keyof StatusResponse]-?: StatusResponse[K] extends string | undefined ? K : never }[keyof StatusResponse];
const STATUS_KEYS = {
  sessionId: 'session_id', sourceChain: 'source_chain', sourceToken: 'source_token', sourceAddress: 'source_address', destinationAddress: 'destination_address',
  destinationChain: 'destination_chain', destinationToken: 'destination_token', depositAddress: 'deposit_address', depositTokenAddress: 'deposit_token_address',
  payoutTokenAddress: 'payout_token_address', amount: 'amount', preparedTxExpiresAt: 'prepared_tx_expires_at', swapToken: 'swap_token', swapTokenExpiresAt: 'swap_token_expires_at',
  txHash: 'tx_hash', payoutTx: 'payout_tx', createdAt: 'created_at', updatedAt: 'updated_at', completedAt: 'completed_at',
} as const satisfies Record<string, StatusStringKey>;

function readStatus(o: JsonObject): SwapStatus {
  const w = o as Partial<StatusResponse>;
  const kind = w.kind === 'prepared' || w.kind === 'session' ? w.kind : undefined;
  const status = typeof w.status === 'string' ? w.status : undefined;
  if (!kind || !status) throw new SwapError('INVALID_RESPONSE', 'Swap status is missing kind/status', { details: o });
  const out: SwapStatus = { kind, status, raw: o };
  const set = <K extends keyof SwapStatus>(k: K, v: SwapStatus[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  const K = STATUS_KEYS;
  set('sessionId', str(o, K.sessionId));
  set('sourceChain', str(o, K.sourceChain) as SwapChain | undefined);
  set('sourceToken', str(o, K.sourceToken) as SwapToken | undefined);
  set('sourceAddress', addr(o, K.sourceAddress));
  set('destinationAddress', addr(o, K.destinationAddress));
  set('destinationChain', str(o, K.destinationChain) as SwapChain | undefined);
  set('destinationToken', str(o, K.destinationToken) as SwapToken | undefined);
  set('depositAddress', addr(o, K.depositAddress));
  set('depositTokenAddress', addr(o, K.depositTokenAddress));
  set('payoutTokenAddress', addr(o, K.payoutTokenAddress));
  set('amount', str(o, K.amount));
  set('unsignedTx', readUnsignedTx(w.unsigned_tx));
  set('preparedTxExpiresAt', date(o, K.preparedTxExpiresAt));
  set('swapToken', str(o, K.swapToken));
  set('swapTokenExpiresAt', date(o, K.swapTokenExpiresAt));
  set('txHash', hash(o, K.txHash));
  set('payoutTx', hash(o, K.payoutTx));
  set('createdAt', date(o, K.createdAt));
  set('updatedAt', date(o, K.updatedAt));
  set('completedAt', date(o, K.completedAt));
  if (isObject(w.error)) {
    const e = w.error as Partial<ErrorEnvelope>;
    if (typeof e.code === 'string') out.error = { code: e.code, message: typeof e.message === 'string' ? e.message : '', requestId: typeof e.request_id === 'string' ? e.request_id : undefined };
  }
  return out;
}

function readRoute(v: unknown): SwapRoute | undefined {
  if (!isObject(v)) return undefined;
  const w = v as Partial<SupportedRoute>;
  const r = {
    sourceChain: typeof w.source_chain === 'string' ? w.source_chain : undefined,
    sourceToken: typeof w.source_token === 'string' ? w.source_token : undefined,
    destinationChain: typeof w.destination_chain === 'string' ? w.destination_chain : undefined,
    destinationToken: typeof w.destination_token === 'string' ? w.destination_token : undefined,
    sourceChainId: typeof w.source_chain_id === 'number' ? w.source_chain_id : undefined,
    sourceTokenContract: addr(v, 'source_token_contract'),
    sourceTokenDecimals: typeof w.source_token_decimals === 'number' ? w.source_token_decimals : undefined,
    destinationChainId: typeof w.destination_chain_id === 'number' ? w.destination_chain_id : undefined,
    destinationTokenContract: addr(v, 'destination_token_contract'),
    destinationTokenDecimals: typeof w.destination_token_decimals === 'number' ? w.destination_token_decimals : undefined,
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
      const err = (isObject(body) && isObject(body.error) ? body.error : {}) as Partial<ErrorEnvelope>;
      const code: SwapErrorCode = typeof err.code === 'string' ? err.code : res.status === 429 ? 'RATE_LIMITED' : res.status === 404 ? 'NOT_FOUND' : res.status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_RESPONSE';
      const message = typeof err.message === 'string' ? err.message : undefined;
      const requestId = (typeof err.request_id === 'string' ? err.request_id : undefined) ?? res.headers.get('x-request-id') ?? undefined;
      let retryAfterMs = typeof err.retry_after_ms === 'number' && Number.isFinite(err.retry_after_ms) ? err.retry_after_ms : undefined;
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
        const w = raw as Partial<InstructionsResponse>;
        const environment = w.environment;
        if (environment !== 'testnet' && environment !== 'mainnet') throw new SwapError('INVALID_RESPONSE', 'Swap instructions name no environment', { details: raw });
        const routes = Array.isArray(w.supported_routes) ? w.supported_routes.map(readRoute).filter((r): r is SwapRoute => r !== undefined) : [];
        const codes = Array.isArray(w.error_codes) ? (w.error_codes as unknown[]).filter(isObject) : [];
        return {
          version: typeof w.version === 'string' ? w.version : '',
          environment,
          overview: typeof w.overview === 'string' ? w.overview : '',
          routes,
          steps: Array.isArray(w.steps) ? w.steps : [],
          importantRules: Array.isArray(w.important_rules) ? (w.important_rules as unknown[]).filter((r): r is string => typeof r === 'string') : [],
          errorCodes: codes.map((c) => ({ code: (str(c, 'code') ?? '') as SwapErrorCode, description: str(c, 'description') ?? '', callerAction: str(c, 'caller_action') ?? '' })),
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
    const w = raw as Partial<PrepareResponse>;
    const unsignedTx = readUnsignedTx(w.unsigned_tx);
    const swapToken = typeof w.swap_token === 'string' ? w.swap_token : undefined;
    const swapTokenExpiresAt = date(raw, 'swap_token_expires_at' satisfies keyof PrepareResponse);
    const preparedTxExpiresAt = date(raw, 'prepared_tx_expires_at' satisfies keyof PrepareResponse);
    const depositAddress = addr(raw, 'deposit_address' satisfies keyof PrepareResponse);
    const depositChain = typeof w.deposit_chain === 'string' ? w.deposit_chain : undefined;
    const depositToken = typeof w.deposit_token === 'string' ? w.deposit_token : undefined;
    const destinationChain = typeof w.destination_chain === 'string' ? w.destination_chain : undefined;
    const destinationToken = typeof w.destination_token === 'string' ? w.destination_token : undefined;
    if (!unsignedTx || !swapToken || !swapTokenExpiresAt || !preparedTxExpiresAt || !depositAddress || !depositChain || !depositToken || !destinationChain || !destinationToken) {
      throw new SwapError('INVALID_RESPONSE', 'Prepare response is missing swap_token, expiry, route or unsigned_tx', { details: raw });
    }
    return {
      swapToken,
      swapTokenExpiresAt,
      preparedTxExpiresAt,
      depositAddress,
      depositTokenAddress: addr(raw, 'deposit_token_address' satisfies keyof PrepareResponse) ?? unsignedTx.to,
      depositChain,
      depositToken,
      destinationChain,
      destinationToken,
      payoutTokenAddress: addr(raw, 'payout_token_address' satisfies keyof PrepareResponse) ?? ('0x0000000000000000000000000000000000000000' as Address),
      amount: typeof w.amount === 'string' ? w.amount : '',
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
    const body: BroadcastRequestWire = { signed_tx: signedTx };
    const raw = await call('/broadcast', { method: 'POST', token: swapToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const w = raw as Partial<BroadcastResponse>;
    const sessionId = typeof w.session_id === 'string' ? w.session_id : undefined;
    const token = typeof w.swap_token === 'string' ? w.swap_token : undefined;
    const expires = date(raw, 'swap_token_expires_at' satisfies keyof BroadcastResponse);
    const txHash = hash(raw, 'tx_hash' satisfies keyof BroadcastResponse);
    const status = typeof w.status === 'string' ? w.status : undefined;
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
    const body: SessionListTokenRequestWire = { source_address: sourceAddress, expires_at: expiresAt, signature };
    const raw = await call('/sessions/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const w = raw as Partial<SessionListTokenResponse>;
    const swapToken = typeof w.swap_token === 'string' ? w.swap_token : undefined;
    const swapTokenExpiresAt = date(raw, 'swap_token_expires_at' satisfies keyof SessionListTokenResponse);
    if (!swapToken || !swapTokenExpiresAt) throw new SwapError('INVALID_RESPONSE', 'Session list token response is missing swap_token', { details: raw });
    return { swapToken, swapTokenExpiresAt, raw };
  };

  const listSessions = async (swapToken: string, query: ListSessionsOptions = {}): Promise<SwapSessionList> => {
    // Typed against the operation's query parameters (all strings on the wire).
    const wire: ListSessionsQuery = {};
    if (query.limit !== undefined) wire.limit = String(query.limit);
    if (query.cursor) wire.cursor = query.cursor;
    if (query.status) wire.status = query.status;
    if (query.sourceChain) wire.source_chain = query.sourceChain;
    if (query.txHash) wire.tx_hash = query.txHash;
    const qs = new URLSearchParams(Object.entries(wire).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    const raw = await call(`/sessions${qs ? `?${qs}` : ''}`, { token: swapToken });
    const r = raw as Partial<ListSessionsResponse>;
    if (!Array.isArray(r.items)) throw new SwapError('INVALID_RESPONSE', 'Session list has no items[]', { details: raw });
    const out: SwapSessionList = { items: r.items.filter(isObject).map(readStatus), raw };
    if (typeof r.next_cursor === 'string' && r.next_cursor) out.nextCursor = r.next_cursor;
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
