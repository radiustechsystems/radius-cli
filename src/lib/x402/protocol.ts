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
}

export interface Challenge {
  x402Version: number;
  accepts: AcceptEntry[];
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
      maxAmountRequired: asBigInt(e.maxAmountRequired, `accepts[${i}].maxAmountRequired`),
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
    } satisfies AcceptEntry;
  });
  return {
    x402Version: version,
    accepts: parsedAccepts,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

export function networkIdForChain(chainId: number): string {
  return `eip155:${chainId}`;
}

export function pickAccept(accepts: AcceptEntry[], chainId: number): AcceptEntry | undefined {
  const target = networkIdForChain(chainId);
  return accepts.find((a) => a.scheme === 'exact' && a.network === target);
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  const json = JSON.stringify({
    x402Version: payload.x402Version,
    scheme: payload.scheme,
    network: payload.network,
    payload: {
      signature: payload.payload.signature,
      authorization: {
        from: payload.payload.authorization.from,
        to: payload.payload.authorization.to,
        value: payload.payload.authorization.value.toString(),
        validAfter: payload.payload.authorization.validAfter,
        validBefore: payload.payload.authorization.validBefore,
        nonce: payload.payload.authorization.nonce,
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
