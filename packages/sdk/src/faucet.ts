/**
 * Client for the Radius faucet API (`<faucetUrl>/openapi.json` documents it; testnet:
 * https://testnet.radiustech.xyz/api/v1/faucet/openapi.json). Wire types come from
 * `src/generated/faucet.ts`, generated from `specs/faucet.openapi.json`; this file is the
 * hand-written flow on top and is what breaks when the spec changes incompatibly.
 *
 * Endpoints:
 *   GET  /status/{address}?token=SBC     rate-limit state and drip amounts
 *   GET  /challenge/{address}?token=SBC  EIP-191 message to sign when signatures are enabled
 *   POST /drip { address, token, signature? }
 *
 * Errors share the Radius API envelope `{ error: { code, message, request_id, retry_after_ms?,
 * details? } }` (`Retry-After` header alongside `retry_after_ms`); `details` carries code-specific
 * context such as the `challenge` to sign for `signature_required` or the `tx_hash` of a drip that
 * reverted or timed out.
 *
 * Signatures are a server-side switch: testnet currently drips unsigned, mainnet is expected to
 * require them, and either can change. `fund()` therefore tries an unsigned drip first and falls
 * back to sign → drip on `signature_required` (`signature: 'always'` skips the unsigned attempt,
 * `'never'` disables the fallback). Where enabled the faucet also drips a little native RUSD for
 * gas as a second transaction, reported under `native`.
 *
 * Everything the faucet returns is treated as data: only the documented fields are read, and
 * free-text fields (`message`, `instructions`) are surfaced but never interpreted.
 */

import { RadiusPaymentError } from './errors.js';
import type { components as FaucetApi, paths as FaucetPaths } from './generated/faucet.js';
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from './networks.js';
import type { ErrorDetailsOf, JsonBody, JsonOk } from './openapi.js';

// ---- wire contract (generated from specs/faucet.openapi.json; see src/openapi.ts) ----------------
// Each operation this client speaks, by path: a renamed or removed endpoint fails to compile here.
type StatusOp = FaucetPaths['/api/v1/faucet/status/{address}']['get'];
type ChallengeOp = FaucetPaths['/api/v1/faucet/challenge/{address}']['get'];
type DripOp = FaucetPaths['/api/v1/faucet/drip']['post'];
/** Wire shapes, as the faucet API documents them. */
export type FaucetApiSchemas = FaucetApi['schemas'];
type StatusResponse = JsonOk<StatusOp>;
type ChallengeResponse = JsonOk<ChallengeOp>;
type DripSuccess = JsonOk<DripOp>;
type DripRequest = JsonBody<DripOp>;
type ErrorEnvelope = ErrorDetailsOf<FaucetApiSchemas['FaucetErrorResponse']>;
/** Token symbols the faucet drips (from the spec). */
export type FaucetToken = DripRequest['token'];
/** Error codes the faucet API documents (from the spec). */
export type FaucetApiErrorCode = ErrorEnvelope['code'];

/**
 * `FaucetApiErrorCode` (`signature_required`, `rate_limited`, `faucet_empty`, `transaction_reverted`,
 * `receipt_timeout`, `native_drip_failed`, …) plus the client's own codes. Kept open (`string`) so a
 * code newer than this SDK passes through untouched.
 */
export type FaucetErrorCode =
  | FaucetApiErrorCode
  /** Client-side: the address is not a 0x address; nothing was sent. */
  | 'invalid_address'
  /** Client-side: the faucet answered with something that is not the documented JSON. */
  | 'invalid_response'
  /** Client-side: the faucet wants a signature and no signer was given. */
  | 'signer_required'
  /** Client-side: no faucet URL for this network. */
  | 'no_faucet'
  | (string & {});

/**
 * A faucet request failed. `code` is always `'faucet'` (so `RadiusPaymentError` handling keeps
 * working); `faucetCode` is the API's own error code, `retryAfterMs` is set for `rate_limited`.
 */
export class FaucetError extends RadiusPaymentError {
  readonly faucetCode: FaucetErrorCode;
  /** HTTP status of the failing response (0 when the request never got one). */
  readonly status: number;
  /** For `rate_limited`: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** `error.request_id` (also the `X-Request-Id` header); quote it when reporting a problem. */
  readonly requestId?: string;
  /** `error.details`: code-specific context, e.g. `{ challenge }` or `{ tx_hash }`. */
  readonly errorDetails?: Record<string, unknown>;
  constructor(
    faucetCode: FaucetErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; requestId?: string; errorDetails?: Record<string, unknown>; details?: unknown } = {},
  ) {
    super('faucet', message, opts.details);
    this.name = 'FaucetError';
    this.faucetCode = faucetCode;
    this.status = opts.status ?? 0;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
    if (opts.errorDetails !== undefined) this.errorDetails = opts.errorDetails;
  }
}

/** `GET /status/{address}`. */
export interface FaucetStatus {
  /** Address as the faucet normalised it (lowercase). */
  address: string;
  token: string;
  rateLimited: boolean;
  /** Milliseconds until the next drip is allowed; only while `rateLimited`. */
  retryAfterMs?: number;
  /** Requests left in the current window (absent when the faucet reports no limit). */
  remainingRequests?: number;
  /** Display amount per drip, e.g. "0.5". */
  dripAmount?: string;
  /** Native RUSD dripped alongside the token for gas, e.g. "0.001"; absent when disabled. */
  nativeDripAmount?: string;
  /** True when rate limiting is switched off for this faucet. */
  unlimited?: boolean;
  raw: unknown;
}

/** `GET /challenge/{address}`. */
export interface FaucetChallenge {
  /** The exact string to sign with EIP-191 `personal_sign`. */
  message: string;
  address: string;
  token: string;
  raw: unknown;
}

/** `POST /drip` success. */
export interface FaucetDrip {
  success: true;
  address: string;
  token: string;
  /** Display amount dripped, e.g. "0.5". */
  amount?: string;
  txHash?: `0x${string}`;
  /** Explorer link for `txHash`, when the network declares an explorer. */
  explorerUrl?: string;
  /** The RUSD gas drip that accompanied the token transfer (a separate transaction), where enabled. */
  native?: { token: string; amount: string; txHash?: `0x${string}` };
  /** Unix seconds when this address may drip again, when the faucet says. */
  nextDripAt?: number;
  raw: unknown;
}

/** Anything that can `personal_sign`: a viem local account, or the SDK's wrapped WalletClient. */
export interface FaucetSigner {
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

export interface FaucetFundOptions {
  /** Needed only when the faucet requires signatures. */
  signer?: FaucetSigner;
  /**
   * `'auto'` (default): drip unsigned, sign only if the faucet asks (`signer_required` if it asks
   * and there is no signer). `'always'`: challenge → sign → drip, no unsigned attempt.
   * `'never'`: unsigned only; `signature_required` is thrown as-is.
   */
  signature?: 'auto' | 'always' | 'never';
}

export interface FaucetClientOptions extends NetworkOverrides {
  /** Which faucet: 'mainnet' (default), 'testnet', a preset, or a custom network with `faucetUrl`. */
  network?: NetworkInput;
  /** Faucet base URL; overrides the network's (`faucetUrl` from `NetworkOverrides` is an alias). */
  url?: string;
  /** Token symbol to request; defaults to the network's payment asset (SBC, the only one the spec lists). */
  token?: FaucetToken | (string & {});
  /** Underlying fetch (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export interface FaucetClient {
  /** Base URL without trailing slash, e.g. https://testnet.radiustech.xyz/api/v1/faucet */
  readonly url: string;
  readonly token: string;
  /** The network this faucet belongs to (for explorer links); undefined when built from a bare `url`. */
  readonly network?: RadiusNetwork;
  /** Rate-limit state and drip amounts for an address. */
  status(address: Address): Promise<FaucetStatus>;
  /** The EIP-191 message the faucet wants signed for `address`. */
  challenge(address: Address): Promise<FaucetChallenge>;
  /** One `POST /drip`, unsigned or with a signature over the current challenge. Throws `FaucetError` on any non-success. */
  drip(address: Address, signature?: `0x${string}`): Promise<FaucetDrip>;
  /** Full flow: unsigned drip, signed fallback when required, one retry on `invalid_signature`. */
  fund(address: Address, options?: FaucetFundOptions): Promise<FaucetDrip>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ParsedError {
  code: FaucetErrorCode;
  message?: string;
  retryAfterMs?: number;
  requestId?: string;
  errorDetails?: Record<string, unknown>;
}

/**
 * Read the error envelope `{ error: { code, message, request_id, retry_after_ms?, details? } }`.
 * A flat `{ error: "code", message?, retry_after_ms? }` (older proxies) is tolerated; the code is
 * derived from the HTTP status when the body names none.
 */
function readError(body: unknown, res: Response): ParsedError {
  const o = isObject(body) ? body : {};
  const err = o.error;
  const out: ParsedError = { code: 'invalid_response' };
  let code: string | undefined;
  if (isObject(err)) {
    const e = err as Partial<ErrorEnvelope>;
    if (typeof e.code === 'string') code = e.code;
    if (typeof e.message === 'string') out.message = e.message;
    if (typeof e.request_id === 'string') out.requestId = e.request_id;
    if (typeof e.retry_after_ms === 'number' && Number.isFinite(e.retry_after_ms)) out.retryAfterMs = e.retry_after_ms;
    if (isObject(e.details)) out.errorDetails = e.details;
  } else if (typeof err === 'string') {
    code = err;
    if (typeof o.message === 'string') out.message = o.message;
    if (typeof o.retry_after_ms === 'number' && Number.isFinite(o.retry_after_ms)) out.retryAfterMs = o.retry_after_ms;
  }
  if (out.retryAfterMs === undefined) {
    const header = Number(res.headers.get('retry-after'));
    if (Number.isFinite(header) && header > 0) out.retryAfterMs = header * 1000;
  }
  out.code = code ?? (res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : res.status >= 500 ? 'internal_error' : 'invalid_response');
  return out;
}

export function createFaucetClient(options: FaucetClientOptions = {}): FaucetClient {
  const { url: urlOption, token: tokenOption, fetch: fetchOption, network: networkOption, ...overrides } = options;
  const hasOverrides = Object.values(overrides).some((v) => v !== undefined);
  const network = urlOption && networkOption === undefined && !hasOverrides ? undefined : resolveNetwork(networkOption, hasOverrides ? overrides : undefined);
  const base = urlOption ?? network?.faucetUrl;
  if (!base) throw new FaucetError('no_faucet', `No faucet configured for network ${network?.name ?? '(unknown)'}; pass { url } or a network with faucetUrl`);
  const url = base.replace(/\/+$/, '');
  const token = tokenOption ?? network?.asset.symbol ?? 'SBC';
  const doFetch = fetchOption ?? globalThis.fetch.bind(globalThis);
  const explorer = (hash: string) => (network?.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined);

  const requireAddress = (address: string): Address => {
    if (!ADDRESS.test(address)) throw new FaucetError('invalid_address', `Not a 0x address: ${address}`);
    return address as Address;
  };

  /** Fetch and parse JSON; any non-2xx or error-shaped body becomes a FaucetError. */
  const call = async (path: string, init?: RequestInit): Promise<JsonObject> => {
    let res: Response;
    try {
      res = await doFetch(`${url}${path}`, { ...init, headers: { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) } });
    } catch (e) {
      throw new FaucetError('invalid_response', `Faucet unreachable at ${url}: ${(e as Error).message}`, { details: e });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const looksLikeError = isObject(body) && (body.error !== undefined || body.success === false);
    if (!res.ok || looksLikeError) {
      const { code, message, retryAfterMs, requestId, errorDetails } = readError(body, res);
      const detail = message ? `: ${message}` : body === undefined && text ? `: ${text.slice(0, 200)}` : '';
      const wait = retryAfterMs !== undefined ? ` (retry in ${Math.ceil(retryAfterMs / 1000)} s)` : '';
      const ref = requestId ? ` [${requestId}]` : '';
      throw new FaucetError(code, `Faucet ${code} (HTTP ${res.status})${detail}${wait}${ref}`, { status: res.status, retryAfterMs, requestId, errorDetails, details: body ?? text });
    }
    if (!isObject(body)) throw new FaucetError('invalid_response', `Faucet returned non-JSON (HTTP ${res.status}) from ${path}`, { status: res.status, details: text });
    return body;
  };

  const status = async (address: Address): Promise<FaucetStatus> => {
    const a = requireAddress(address);
    const raw = await call(`/status/${a}?token=${encodeURIComponent(token)}`);
    // Field names come from the spec; values are still checked, JSON being untrusted input.
    const r = raw as Partial<StatusResponse>;
    if (typeof r.rate_limited !== 'boolean') throw new FaucetError('invalid_response', 'Faucet status has no boolean rate_limited', { details: raw });
    const out: FaucetStatus = { address: typeof r.address === 'string' ? r.address : a.toLowerCase(), token: typeof r.token === 'string' ? r.token : token, rateLimited: r.rate_limited, raw };
    if (typeof r.retry_after_ms === 'number' && Number.isFinite(r.retry_after_ms)) out.retryAfterMs = r.retry_after_ms;
    // `remaining_requests` is null on the wire when the faucet has no limit (Infinity does not survive JSON).
    if (typeof r.remaining_requests === 'number' && Number.isFinite(r.remaining_requests)) out.remainingRequests = r.remaining_requests;
    const drip: unknown = r.drip_amount;
    if (typeof drip === 'string') out.dripAmount = drip;
    else if (typeof drip === 'number') out.dripAmount = String(drip);
    if (typeof r.native_drip_amount === 'string') out.nativeDripAmount = r.native_drip_amount;
    if (r.unlimited === true) out.unlimited = true;
    return out;
  };

  const challenge = async (address: Address): Promise<FaucetChallenge> => {
    const a = requireAddress(address);
    const raw = await call(`/challenge/${a}?token=${encodeURIComponent(token)}`);
    const r = raw as Partial<ChallengeResponse>;
    if (typeof r.message !== 'string' || !r.message) throw new FaucetError('invalid_response', 'Faucet challenge has no message to sign', { details: raw });
    return { message: r.message, address: typeof r.address === 'string' ? r.address : a.toLowerCase(), token: typeof r.token === 'string' ? r.token : token, raw };
  };

  const drip = async (address: Address, signature?: `0x${string}`): Promise<FaucetDrip> => {
    const a = requireAddress(address);
    // The spec enumerates the tokens; `token` is left open for custom assets and cast at the boundary.
    const body: Omit<DripRequest, 'token'> & { token: string } = signature ? { address: a, token, signature } : { address: a, token };
    const raw = await call('/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = raw as Partial<DripSuccess>;
    if (r.success !== true) throw new FaucetError('invalid_response', 'Faucet drip answered without success: true', { status: 200, details: raw });
    const out: FaucetDrip = { success: true, address: typeof r.address === 'string' ? r.address : a, token: typeof r.token === 'string' ? r.token : token, raw };
    if (typeof r.amount === 'string') out.amount = r.amount;
    if (typeof r.tx_hash === 'string' && TX_HASH.test(r.tx_hash)) {
      out.txHash = r.tx_hash as `0x${string}`;
      const link = explorer(r.tx_hash);
      if (link) out.explorerUrl = link;
    }
    if (isObject(r.native)) {
      const n = r.native as Partial<NonNullable<DripSuccess['native']>>;
      out.native = { token: typeof n.token === 'string' ? n.token : 'RUSD', amount: typeof n.amount === 'string' ? n.amount : '' };
      if (typeof n.tx_hash === 'string' && TX_HASH.test(n.tx_hash)) out.native.txHash = n.tx_hash as `0x${string}`;
    }
    if (typeof r.next_drip_at === 'number' && Number.isFinite(r.next_drip_at)) out.nextDripAt = r.next_drip_at;
    return out;
  };

  const fund = async (address: Address, options: FaucetFundOptions = {}): Promise<FaucetDrip> => {
    const a = requireAddress(address);
    const { signer } = options;
    const mode = options.signature ?? 'auto';
    // The `signature_required` error carries the challenge in `details.challenge`; use it and skip GET /challenge.
    let message: string | undefined;
    if (mode !== 'always') {
      try {
        return await drip(a);
      } catch (e) {
        if (!(e instanceof FaucetError) || e.faucetCode !== 'signature_required' || mode === 'never') throw e;
        if (!signer) {
          throw new FaucetError('signer_required', `The ${token} faucet at ${url} requires a signature; fund() needs a signer with signMessage (EIP-191), e.g. a private key or viem local account`, { status: e.status, requestId: e.requestId, details: e.details });
        }
        const offered = e.errorDetails?.challenge;
        if (typeof offered === 'string' && offered) message = offered;
      }
    }
    if (!signer || typeof signer.signMessage !== 'function') {
      throw new FaucetError('signer_required', "signature: 'always' needs a signer with signMessage (EIP-191)");
    }
    // A stale challenge (rotated between fetch and drip) yields invalid_signature once; re-fetch and retry a single time.
    for (let attempt = 0; ; attempt++) {
      if (message === undefined) message = (await challenge(a)).message;
      const signature = await signer.signMessage({ message });
      try {
        return await drip(a, signature);
      } catch (e) {
        if (attempt === 0 && e instanceof FaucetError && e.faucetCode === 'invalid_signature') {
          message = undefined;
          continue;
        }
        throw e;
      }
    }
  };

  return { url, token, network, status, challenge, drip, fund };
}
