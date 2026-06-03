import { isAddress, type Address, type Hex } from 'viem';

export const X402_VERSION = 1;

export interface AcceptEntry {
  scheme: string;
  network: string;
  asset: Address;
  payTo: Address;
  maxAmountRequired: bigint;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  /** the accepts entry exactly as the server sent it — echoed back as `accepted` in v2 payment headers */
  raw: Record<string, unknown>;
}

export interface Challenge {
  x402Version: number;
  accepts: AcceptEntry[];
  /** v2 challenges carry a top-level resource object — echoed back in v2 payment headers */
  resource?: unknown;
  error?: string;
}

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: number;
  validBefore: number;
  nonce: Hex;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  /** v2 only: the chosen accepts entry verbatim and the challenge's resource object */
  accepted?: Record<string, unknown>;
  resource?: unknown;
  payload: { signature: Hex; authorization: Authorization };
}

export interface PaymentResponseBody {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string | null;
}

function asObject(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('x402 challenge: expected JSON object');
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`x402 challenge: missing or invalid string field '${field}'`);
  }
  return v;
}

function asAddress(v: unknown, field: string): Address {
  const s = asString(v, field);
  if (!isAddress(s)) throw new Error(`x402 challenge: '${field}' is not a valid 0x address: ${s}`);
  return s;
}

function asBigInt(v: unknown, field: string): bigint {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`x402 challenge: '${field}' must be a non-negative integer (got ${typeof v})`);
}

export function parseChallenge(raw: unknown): Challenge {
  const obj = asObject(raw);
  const version = obj.x402Version;
  if (typeof version !== 'number') {
    throw new Error("x402 challenge: missing 'x402Version'");
  }
  const accepts = obj.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error("x402 challenge: 'accepts' must be a non-empty array");
  }
  const parsedAccepts = accepts.map((entry, i) => {
    const e = asObject(entry);
    return {
      scheme: asString(e.scheme, `accepts[${i}].scheme`),
      network: asString(e.network, `accepts[${i}].network`),
      asset: asAddress(e.asset, `accepts[${i}].asset`),
      payTo: asAddress(e.payTo, `accepts[${i}].payTo`),
      maxAmountRequired: asBigInt(
        e.maxAmountRequired ?? e.amount,
        e.maxAmountRequired !== undefined
          ? `accepts[${i}].maxAmountRequired`
          : e.amount !== undefined
            ? `accepts[${i}].amount`
            : `accepts[${i}].maxAmountRequired`,
      ),
      resource: typeof e.resource === 'string' ? e.resource : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
      mimeType: typeof e.mimeType === 'string' ? e.mimeType : undefined,
      outputSchema: e.outputSchema,
      maxTimeoutSeconds:
        typeof e.maxTimeoutSeconds === 'number' && e.maxTimeoutSeconds > 0
          ? Math.floor(e.maxTimeoutSeconds)
          : undefined,
      extra: e.extra && typeof e.extra === 'object' && !Array.isArray(e.extra)
        ? (e.extra as AcceptEntry['extra'])
        : undefined,
      raw: e,
    } satisfies AcceptEntry;
  });
  return {
    x402Version: version,
    accepts: parsedAccepts,
    resource: obj.resource,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

/**
 * Radius x402 flavor: SBC has no EIP-3009, so servers advertising
 * `extra.settlementMethod: "permit-transferFrom"` settle via EIP-2612.
 * The header keeps the flat v1-style envelope with a permit payload
 * (`kind: "permit-eip2612"`) per the radius-dev integration guide.
 */
export function encodePermitPaymentHeader(args: {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { kind: 'permit-eip2612'; [k: string]: unknown };
}): string {
  const json = JSON.stringify({
    x402Version: args.x402Version,
    scheme: args.scheme,
    network: args.network,
    payload: args.payload,
  });
  return Buffer.from(json, 'utf8').toString('base64');
}

export function networkIdForChain(chainId: number): string {
  return `eip155:${chainId}`;
}

export function pickAccept(accepts: AcceptEntry[], chainId: number): AcceptEntry | undefined {
  const target = networkIdForChain(chainId);
  return accepts.find((a) => a.scheme === 'exact' && a.network === target);
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  const a = payload.payload.authorization;
  // v2 (specs/schemes/exact/scheme_exact_evm.md): the header echoes the chosen
  // accepts entry as `accepted` plus the challenge's `resource`, and the
  // authorization validity bounds are strings. v1 keeps the flat envelope.
  const json = payload.x402Version >= 2
    ? JSON.stringify({
        x402Version: payload.x402Version,
        scheme: payload.scheme,
        network: payload.network,
        ...(payload.resource !== undefined ? { resource: payload.resource } : {}),
        accepted: payload.accepted ?? { scheme: payload.scheme, network: payload.network },
        payload: {
          signature: payload.payload.signature,
          authorization: {
            from: a.from,
            to: a.to,
            value: a.value.toString(),
            validAfter: a.validAfter.toString(),
            validBefore: a.validBefore.toString(),
            nonce: a.nonce,
          },
        },
      })
    : JSON.stringify({
        x402Version: payload.x402Version,
        scheme: payload.scheme,
        network: payload.network,
        payload: {
          signature: payload.payload.signature,
          authorization: {
            from: a.from,
            to: a.to,
            value: a.value.toString(),
            validAfter: a.validAfter,
            validBefore: a.validBefore,
            nonce: a.nonce,
          },
        },
      });
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodePaymentResponse(headerValue: string): PaymentResponseBody {
  const json = Buffer.from(headerValue, 'base64').toString('utf8');
  const obj = JSON.parse(json) as Record<string, unknown>;
  return {
    success: obj.success === true,
    transaction: typeof obj.transaction === 'string' ? obj.transaction : undefined,
    network: typeof obj.network === 'string' ? obj.network : undefined,
    payer: typeof obj.payer === 'string' ? obj.payer : undefined,
    errorReason: typeof obj.errorReason === 'string' ? obj.errorReason : null,
  };
}
