/**
 * Client for the Radius faucet API (`<faucetUrl>/openapi.json` documents it; testnet:
 * https://testnet.radiustech.xyz/api/v1/faucet/openapi.json).
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
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from './networks.js';

/** Machine-readable error codes the faucet documents, plus the client's own for malformed answers. */
export type FaucetErrorCode =
  | 'invalid_request'
  | 'signature_required'
  | 'invalid_signature'
  | 'rate_limited'
  /** Faucet wallet is low on SBC or RUSD; nothing was sent. */
  | 'faucet_empty'
  | 'sbc_not_configured'
  | 'faucet_not_configured'
  /** Drip mined but reverted (`errorDetails.tx_hash`); the quota was consumed. */
  | 'transaction_reverted'
  /** Drip broadcast but no receipt in time (`errorDetails.tx_hash`); it may still confirm. */
  | 'receipt_timeout'
  /** SBC arrived but the RUSD gas drip failed (`errorDetails.tx_hash` is the SBC transfer). */
  | 'native_drip_failed'
  | 'not_found'
  | 'method_not_allowed'
  | 'internal_error'
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
  /** Token symbol to request; defaults to the network's payment asset (SBC). */
  token?: string;
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

function optionalString(o: JsonObject, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function optionalNumber(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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
    code = optionalString(err, 'code');
    out.message = optionalString(err, 'message');
    out.requestId = optionalString(err, 'request_id');
    out.retryAfterMs = optionalNumber(err, 'retry_after_ms');
    if (isObject(err.details)) out.errorDetails = err.details;
  } else if (typeof err === 'string') {
    code = err;
    out.message = optionalString(o, 'message');
    out.retryAfterMs = optionalNumber(o, 'retry_after_ms');
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
    if (typeof raw.rate_limited !== 'boolean') throw new FaucetError('invalid_response', 'Faucet status has no boolean rate_limited', { details: raw });
    const out: FaucetStatus = { address: optionalString(raw, 'address') ?? a.toLowerCase(), token: optionalString(raw, 'token') ?? token, rateLimited: raw.rate_limited, raw };
    const retry = optionalNumber(raw, 'retry_after_ms');
    if (retry !== undefined) out.retryAfterMs = retry;
    // `remaining_requests` is null on the wire when the faucet has no limit (Infinity does not survive JSON).
    const remaining = optionalNumber(raw, 'remaining_requests');
    if (remaining !== undefined) out.remainingRequests = remaining;
    const drip = raw.drip_amount;
    if (typeof drip === 'string') out.dripAmount = drip;
    else if (typeof drip === 'number') out.dripAmount = String(drip);
    const native = optionalString(raw, 'native_drip_amount');
    if (native !== undefined) out.nativeDripAmount = native;
    if (raw.unlimited === true) out.unlimited = true;
    return out;
  };

  const challenge = async (address: Address): Promise<FaucetChallenge> => {
    const a = requireAddress(address);
    const raw = await call(`/challenge/${a}?token=${encodeURIComponent(token)}`);
    const message = optionalString(raw, 'message');
    if (!message) throw new FaucetError('invalid_response', 'Faucet challenge has no message to sign', { details: raw });
    return { message, address: optionalString(raw, 'address') ?? a.toLowerCase(), token: optionalString(raw, 'token') ?? token, raw };
  };

  const drip = async (address: Address, signature?: `0x${string}`): Promise<FaucetDrip> => {
    const a = requireAddress(address);
    const raw = await call('/drip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signature ? { address: a, token, signature } : { address: a, token }),
    });
    if (raw.success !== true) throw new FaucetError('invalid_response', 'Faucet drip answered without success: true', { status: 200, details: raw });
    const out: FaucetDrip = { success: true, address: optionalString(raw, 'address') ?? a, token: optionalString(raw, 'token') ?? token, raw };
    const amount = optionalString(raw, 'amount');
    if (amount !== undefined) out.amount = amount;
    const hash = optionalString(raw, 'tx_hash') ?? optionalString(raw, 'txHash');
    if (hash && TX_HASH.test(hash)) {
      out.txHash = hash as `0x${string}`;
      const link = explorer(hash);
      if (link) out.explorerUrl = link;
    }
    if (isObject(raw.native)) {
      const n = raw.native;
      const nativeHash = optionalString(n, 'tx_hash');
      out.native = { token: optionalString(n, 'token') ?? 'RUSD', amount: optionalString(n, 'amount') ?? '' };
      if (nativeHash && TX_HASH.test(nativeHash)) out.native.txHash = nativeHash as `0x${string}`;
    }
    const next = optionalNumber(raw, 'next_drip_at');
    if (next !== undefined) out.nextDripAt = next;
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
