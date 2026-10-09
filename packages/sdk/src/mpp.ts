/**
 * Wire format of MPP (Machine Payments Protocol, the HTTP `Payment` authentication scheme,
 * draft-httpauth-payment) for its `evm` / `charge` method: an EIP-3009 `transferWithAuthorization`
 * signed by the payer and settled through an x402 facilitator.
 *
 *   402 + `WWW-Authenticate: Payment id="…", realm="…", method="evm", intent="charge",
 *         request="<b64url JSON>", expires="<ISO>"`        one challenge per network offered
 *   retry + `Authorization: Payment <b64url JSON {challenge, payload, source}>`
 *   200 + `Payment-Receipt: <b64url JSON {method, reference, status, timestamp}>`
 *
 * Matches mppx 0.13 (the reference implementation, interop-tested). Shared by the client and the
 * server, so it has no viem: hashing is @noble/hashes, HMAC is WebCrypto.
 */

import { keccak_256 } from '@noble/hashes/sha3';

export const MPP_SCHEME = 'Payment';
export const MPP_RECEIPT_HEADER = 'payment-receipt';
export const MPP_METHOD = 'evm';
export const MPP_INTENT = 'charge';

/** The `request` of an `evm` / `charge` challenge. */
export interface MppChargeRequest {
  /** Atomic amount. */
  amount: string;
  /** ERC-20 contract. */
  currency: string;
  recipient: string;
  description?: string;
  externalId?: string;
  methodDetails: {
    chainId: number;
    decimals?: number;
    credentialTypes?: string[];
    splits?: unknown[];
    permit2Address?: string;
  };
}

/** A `Payment` challenge as it appears in `WWW-Authenticate`. */
export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** Decoded `request` parameter. */
  request: Record<string, unknown>;
  /** `request` exactly as the server sent it (base64url JSON). */
  requestEncoded: string;
  description?: string;
  digest?: string;
  /** ISO 8601. */
  expires?: string;
  /** Header the credential goes in, when not `Authorization`. */
  header?: string;
  /** Server-defined base64url data, echoed untouched. */
  opaque?: string;
}

export interface MppAuthorizationPayload {
  type: 'authorization';
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

export interface MppCredential {
  challenge: Omit<MppChallenge, 'requestEncoded' | 'request'> & { request: string };
  payload: MppAuthorizationPayload;
  source?: string;
}

export interface MppReceipt {
  method: string;
  /** Settlement transaction hash. */
  reference: string;
  status: 'success';
  /** ISO 8601. */
  timestamp: string;
  externalId?: string;
}

// -- base64url and canonical JSON --------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return decoder.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** RFC 8785-style canonical JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The `request` parameter: base64url of the canonical JSON. */
export function encodeRequest(request: Record<string, unknown>): string {
  return base64UrlEncode(canonicalJson(request));
}

// -- WWW-Authenticate -------------------------------------------------------------------------

const MAX_REQUEST_LENGTH = 16 * 1024;

/** Every `Payment` challenge in a `WWW-Authenticate` value (several may share one header). Malformed ones are skipped. */
export function parseMppChallenges(header: string | null): MppChallenge[] {
  if (!header) return [];
  const starts = schemeStarts(header, MPP_SCHEME);
  const out: MppChallenge[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : header.length;
    try {
      out.push(parseChallenge(header.slice(start + MPP_SCHEME.length, end).replace(/,\s*$/, '')));
    } catch {
      /* not a usable Payment challenge */
    }
  });
  return out;
}

function parseChallenge(params: string): MppChallenge {
  const p = parseAuthParams(params);
  const { id, realm, method, intent, request } = p;
  if (!id || realm === undefined || !method || !intent || !request) throw new Error('incomplete Payment challenge');
  if (request.length > MAX_REQUEST_LENGTH) throw new Error('request parameter too large');
  const decoded = JSON.parse(base64UrlDecode(request)) as unknown;
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('request is not an object');
  return {
    id,
    realm,
    method,
    intent,
    request: decoded as Record<string, unknown>,
    requestEncoded: request,
    ...(p.description !== undefined && { description: p.description }),
    ...(p.digest !== undefined && { digest: p.digest }),
    ...(p.expires !== undefined && { expires: p.expires }),
    ...(p.header !== undefined && { header: p.header }),
    ...(p.opaque !== undefined && { opaque: p.opaque }),
  };
}

/** Offsets where `token` starts an auth scheme (outside quoted strings, at the start or after a comma). */
function schemeStarts(value: string, token: string): number[] {
  const starts: number[] = [];
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inQuotes = false;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (value.slice(i, i + token.length).toLowerCase() !== token.toLowerCase() || !/\s/.test(value[i + token.length] ?? '')) continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(value[j])) j--;
    if (j < 0 || value[j] === ',') starts.push(i);
  }
  return starts;
}

function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i])) i++;
    if (i >= input.length) break;
    const keyStart = i;
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i])) i++;
    const key = input.slice(keyStart, i).toLowerCase();
    if (!key) throw new Error('malformed auth-param');
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== '=') break; // the next auth scheme
    i++;
    while (i < input.length && /\s/.test(input[i])) i++;
    let value: string;
    if (input[i] === '"') {
      [value, i] = readQuoted(input, i + 1);
    } else {
      const start = i;
      while (i < input.length && input[i] !== ',') i++;
      value = input.slice(start, i).trim();
    }
    if (key in result) throw new Error(`duplicate parameter ${key}`);
    result[key] = value;
  }
  return result;
}

function readQuoted(input: string, start: number): [string, number] {
  let out = '';
  for (let i = start; i < input.length; i++) {
    const c = input[i];
    if (c === '"') return [out, i + 1];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = input[++i];
    const hex = input.slice(i + 1, i + 5);
    if (next === 'u' && /^[0-9A-Fa-f]{4}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
    } else out += next ?? '';
  }
  throw new Error('unterminated quoted-string');
}

function authParam(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`invalid ${name}: line breaks are not allowed`);
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[Ā-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${name}="${escaped}"`;
}

/** One `WWW-Authenticate` challenge. */
export function serializeMppChallenge(c: MppChallenge): string {
  const parts = [authParam('id', c.id), authParam('realm', c.realm), authParam('method', c.method), authParam('intent', c.intent), authParam('request', c.requestEncoded)];
  if (c.description !== undefined) parts.push(authParam('description', c.description));
  if (c.digest !== undefined) parts.push(authParam('digest', c.digest));
  if (c.expires !== undefined) parts.push(authParam('expires', c.expires));
  if (c.header !== undefined) parts.push(authParam('header', c.header));
  if (c.opaque !== undefined) parts.push(authParam('opaque', c.opaque));
  return `${MPP_SCHEME} ${parts.join(', ')}`;
}

// -- challenge id, nonce -----------------------------------------------------------------------

/**
 * The challenge id: HMAC-SHA256 (base64url) over `realm|method|intent|request|expires|digest|opaque`
 * (a non-default credential header is bound before `opaque`). Stateless: the server recomputes it
 * from the echoed challenge to prove it issued those exact parameters.
 */
export async function mppChallengeId(secret: string | CryptoKey, c: Omit<MppChallenge, 'id'>): Promise<string> {
  const slots = [c.realm, c.method, c.intent, encodeRequest(c.request), c.expires ?? '', c.digest ?? ''];
  if (c.header !== undefined && c.header.toLowerCase() !== 'authorization') slots.push(c.header);
  slots.push(c.opaque ?? '');
  const key = typeof secret === 'string' ? await mppHmacKey(secret) : secret;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(slots.join('|'))));
  return base64UrlEncode(mac);
}

/** The HMAC-SHA256 key for `mppChallengeId`; import once and reuse. */
export function mppHmacKey(secretKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** EIP-3009 nonce binding an authorization to its challenge: keccak256(JSON.stringify([id, realm])). */
export function mppChallengeNonce(c: { id: string; realm: string }): `0x${string}` {
  const hash = keccak_256(encoder.encode(JSON.stringify([c.id, c.realm])));
  return `0x${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// -- credential and receipt --------------------------------------------------------------------

/** `Authorization` value for a credential answering `challenge` (echoed as received). */
export function serializeMppCredential(challenge: MppChallenge, payload: MppAuthorizationPayload, source?: string): string {
  const { request: _decoded, requestEncoded, ...rest } = challenge;
  const wire: MppCredential = { challenge: { ...rest, request: requestEncoded }, payload, ...(source && { source }) };
  return `${MPP_SCHEME} ${base64UrlEncode(JSON.stringify(wire))}`;
}

/** The credential in an `Authorization: Payment …` value, or undefined when there is none. Throws when it is malformed. */
export function parseMppCredential(header: string | null): { challenge: MppChallenge; payload: MppAuthorizationPayload; source?: string } | undefined {
  const m = header ? /^Payment\s+(\S+)\s*$/i.exec(header) : null;
  if (!m) return undefined;
  const wire = JSON.parse(base64UrlDecode(m[1])) as { challenge?: Record<string, unknown>; payload?: unknown; source?: unknown };
  const c = wire.challenge;
  if (!c || typeof c !== 'object' || typeof c.request !== 'string') throw new Error('credential has no challenge');
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : undefined);
  const id = str('id');
  const realm = str('realm');
  const method = str('method');
  const intent = str('intent');
  if (!id || realm === undefined || !method || !intent) throw new Error('credential challenge is incomplete');
  const request = JSON.parse(base64UrlDecode(c.request)) as Record<string, unknown>;
  const challenge: MppChallenge = {
    id,
    realm,
    method,
    intent,
    request,
    requestEncoded: c.request,
    ...(str('description') !== undefined && { description: str('description') }),
    ...(str('digest') !== undefined && { digest: str('digest') }),
    ...(str('expires') !== undefined && { expires: str('expires') }),
    ...(str('header') !== undefined && { header: str('header') }),
    ...(str('opaque') !== undefined && { opaque: str('opaque') }),
  };
  const payload = wire.payload as MppAuthorizationPayload;
  if (!payload || typeof payload !== 'object') throw new Error('credential has no payload');
  return { challenge, payload, ...(typeof wire.source === 'string' && { source: wire.source }) };
}

export function serializeMppReceipt(r: MppReceipt): string {
  return base64UrlEncode(JSON.stringify(r));
}

export function parseMppReceipt(header: string): MppReceipt {
  const r = JSON.parse(base64UrlDecode(header)) as Partial<MppReceipt>;
  if (typeof r.method !== 'string' || typeof r.reference !== 'string' || r.status !== 'success') throw new Error('malformed Payment-Receipt');
  return r as MppReceipt;
}

/** `did:pkh` source identifier of a payer. */
export function mppSource(chainId: number, address: string): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}
