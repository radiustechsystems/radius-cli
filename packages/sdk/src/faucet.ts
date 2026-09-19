/**
 * Client for the Radius faucet API (`<faucetUrl>/openapi.json` documents it; testnet:
 * https://testnet.radiustech.xyz/api/v1/faucet/openapi.json).
 *
 * Endpoints:
 *   GET  /status/{address}?token=SBC     rate-limit state and drip amount
 *   GET  /challenge/{address}?token=SBC  EIP-191 message to sign when signatures are enabled
 *   POST /drip { address, token, signature? }
 *
 * Signatures are a server-side switch: testnet currently drips unsigned, mainnet is expected to
 * require them, and either can change. `fund()` therefore tries an unsigned drip first and falls
 * back to challenge → sign → drip on `signature_required` (`signature: 'always'` skips the
 * unsigned attempt, `'never'` disables the fallback).
 *
 * Everything the faucet returns is treated as data: only the documented fields are read, and
 * free-text fields (`message`, `instructions`) are surfaced but never interpreted.
 */

import { RadiusPaymentError } from './errors.js';
import { resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from './networks.js';

/** Machine-readable error codes the faucet documents, plus the client's own for malformed answers. */
export type FaucetErrorCode =
  | 'signature_required'
  | 'invalid_signature'
  | 'invalid_address'
  | 'invalid_token'
  | 'rate_limited'
  | 'faucet_empty'
  | 'sbc_not_configured'
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
  constructor(faucetCode: FaucetErrorCode, message: string, opts: { status?: number; retryAfterMs?: number; details?: unknown } = {}) {
    super('faucet', message, opts.details);
    this.name = 'FaucetError';
    this.faucetCode = faucetCode;
    this.status = opts.status ?? 0;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
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
  /** Requests left in the current window. */
  remainingRequests?: number;
  /** Display amount per drip, e.g. "0.5". */
  dripAmount?: string;
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
  /** Rate-limit state and drip amount for an address. */
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

/** Error code and detail from an error body: `{ error: "code", message?, retry_after_ms? }` (also tolerates `{ error: { code, message } }`). */
function readError(body: unknown, res: Response): { code: FaucetErrorCode; message?: string; retryAfterMs?: number } {
  const o = isObject(body) ? body : {};
  const err = o.error;
  let code: string | undefined;
  let message = optionalString(o, 'message');
  if (typeof err === 'string') code = err;
  else if (isObject(err)) {
    code = optionalString(err, 'code');
    message ??= optionalString(err, 'message');
  }
  let retryAfterMs = optionalNumber(o, 'retry_after_ms') ?? (isObject(err) ? optionalNumber(err, 'retry_after_ms') : undefined);
  if (retryAfterMs === undefined) {
    const header = Number(res.headers.get('retry-after'));
    if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000;
  }
  return { code: code ?? (res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'internal_error' : 'invalid_response'), message, retryAfterMs };
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
      const { code, message, retryAfterMs } = readError(body, res);
      const detail = message ? `: ${message}` : body === undefined && text ? `: ${text.slice(0, 200)}` : '';
      const wait = retryAfterMs !== undefined ? ` (retry in ${Math.ceil(retryAfterMs / 1000)} s)` : '';
      throw new FaucetError(code, `Faucet ${code} (HTTP ${res.status})${detail}${wait}`, { status: res.status, retryAfterMs, details: body ?? text });
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
    const remaining = optionalNumber(raw, 'remaining_requests');
    if (remaining !== undefined) out.remainingRequests = remaining;
    const drip = raw.drip_amount;
    if (typeof drip === 'string') out.dripAmount = drip;
    else if (typeof drip === 'number') out.dripAmount = String(drip);
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
    return out;
  };

  const fund = async (address: Address, options: FaucetFundOptions = {}): Promise<FaucetDrip> => {
    const a = requireAddress(address);
    const { signer } = options;
    const mode = options.signature ?? 'auto';
    if (mode !== 'always') {
      try {
        return await drip(a);
      } catch (e) {
        if (!(e instanceof FaucetError) || e.faucetCode !== 'signature_required' || mode === 'never') throw e;
        if (!signer) {
          throw new FaucetError('signer_required', `The ${token} faucet at ${url} requires a signature; fund() needs a signer with signMessage (EIP-191), e.g. a private key or viem local account`, { status: e.status, details: e.details });
        }
      }
    }
    if (!signer || typeof signer.signMessage !== 'function') {
      throw new FaucetError('signer_required', "signature: 'always' needs a signer with signMessage (EIP-191)");
    }
    // A stale challenge (rotated between fetch and drip) yields invalid_signature once; re-fetch and retry a single time.
    for (let attempt = 0; ; attempt++) {
      const { message } = await challenge(a);
      const signature = await signer.signMessage({ message });
      try {
        return await drip(a, signature);
      } catch (e) {
        if (attempt === 0 && e instanceof FaucetError && e.faucetCode === 'invalid_signature') continue;
        throw e;
      }
    }
  };

  return { url, token, network, status, challenge, drip, fund };
}
