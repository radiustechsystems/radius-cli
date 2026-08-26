import { isAddress, type Address, type Hex } from 'viem';

// x402 protocol versions this client understands.
export const X402_VERSION = 1;
export const X402_VERSION_V2 = 2;

// v1 client→server / server→client headers.
export const V1_PAYMENT_HEADER = 'x-payment';
export const V1_PAYMENT_RESPONSE_HEADER = 'x-payment-response';

// v2 renames the wire headers. The 402 challenge may also arrive in the body.
export const V2_PAYMENT_REQUIRED_HEADER = 'payment-required';
export const V2_PAYMENT_SIGNATURE_HEADER = 'payment-signature';
export const V2_PAYMENT_RESPONSE_HEADER = 'payment-response';

export interface AcceptEntry {
  scheme: string;
  network: string;
  asset: Address;
  payTo: Address;
  // Authorized amount in atomic units. v1 calls this `maxAmountRequired`; v2 calls it `amount`.
  // For `upto` this is the MAX the client authorizes; the facilitator settles ≤ this.
  maxAmountRequired: bigint;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  maxTimeoutSeconds?: number;
  extra?: {
    name?: string;
    version?: string;
    facilitatorAddress?: string;
    facilitator?: string;
    [k: string]: unknown;
  };
}

export interface Challenge {
  x402Version: number;
  accepts: AcceptEntry[];
  error?: string;
}

// EIP-3009 authorization (exact@v1 / exact payloads).
export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: number;
  validBefore: number;
  nonce: Hex;
}

export interface PaymentResponseBody {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  // Actual amount charged (atomic-unit string). v2 `upto` may settle less than the max, or 0.
  amount?: string;
  errorReason?: string | null;
}

/**
 * Validate the settlement amount returned for an `upto` payment.
 *
 * The amount is expressed in atomic units and is an untrusted receipt field: a
 * client must never present a value above the maximum it authorized.
 */
export function parseUptoSettlementAmount(amount: string, maximum: bigint): bigint {
  if (!/^[0-9]+$/.test(amount)) {
    throw new Error("x402 payment response: 'amount' must be a non-negative integer string");
  }
  const settled = BigInt(amount);
  if (settled > maximum) {
    throw new Error(
      `x402 payment response: settlement amount ${settled} exceeds authorized maximum ${maximum}`,
    );
  }
  return settled;
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

/**
 * Parse a v1 or v2 challenge. v1 carries the authorized amount in `maxAmountRequired`;
 * v2 renames it to `amount`. Both are normalized onto `AcceptEntry.maxAmountRequired`.
 */
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
    const amountField = e.amount !== undefined ? 'amount' : 'maxAmountRequired';
    return {
      scheme: asString(e.scheme, `accepts[${i}].scheme`),
      network: asString(e.network, `accepts[${i}].network`),
      asset: asAddress(e.asset, `accepts[${i}].asset`),
      payTo: asAddress(e.payTo, `accepts[${i}].payTo`),
      maxAmountRequired: asBigInt(e[amountField], `accepts[${i}].${amountField}`),
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

/** CAIP-2 network id for an EVM chain, e.g. `eip155:84532`. */
export function networkIdForChain(chainId: number): string {
  return `eip155:${chainId}`;
}

/** Parse a CAIP-2 `eip155:<id>` network string to a chain id, or undefined if not EVM/parseable. */
export function chainIdForNetwork(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** True when the accept entry's network matches the configured chain id. */
export function networkMatchesChain(network: string, chainId: number): boolean {
  return chainIdForNetwork(network) === chainId;
}

// -- v1 EIP-3009 header (exact@v1) ------------------------------------------------

export interface V1PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: Hex; authorization: Authorization };
}

export function encodePaymentHeader(payload: V1PaymentPayload): string {
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

/** Base64-encode an already-built JSON-serializable payload (used by v2 handlers). */
export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** Decode a settlement response from either the v1 or v2 response header. */
export function decodePaymentResponse(headerValue: string): PaymentResponseBody {
  const json = Buffer.from(headerValue, 'base64').toString('utf8');
  const obj = JSON.parse(json) as Record<string, unknown>;
  if (obj.amount !== undefined && (typeof obj.amount !== 'string' || !/^[0-9]+$/.test(obj.amount))) {
    throw new Error("x402 payment response: 'amount' must be a non-negative integer string");
  }
  return {
    success: obj.success === true,
    transaction: typeof obj.transaction === 'string' ? obj.transaction : undefined,
    network: typeof obj.network === 'string' ? obj.network : undefined,
    payer: typeof obj.payer === 'string' ? obj.payer : undefined,
    amount: obj.amount as string | undefined,
    errorReason: typeof obj.errorReason === 'string' ? obj.errorReason : null,
  };
}
