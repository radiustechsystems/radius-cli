import { decodePaymentResponseHeader } from '@x402/core/http';
import { explorerTxUrl, type PaymentNetwork } from './networks.js';

/** Decoded `PAYMENT-RESPONSE` header: what the facilitator reported after settlement. */
export interface PaymentReceipt {
  success: boolean;
  /** Settlement transaction hash (empty/undefined when settlement failed). */
  transaction?: string;
  /** CAIP-2 network the settlement happened on. */
  network: string;
  payer?: string;
  /**
   * Atomic amount charged. For the `exact` scheme this is the requested amount; facilitators
   * only report it themselves for schemes (like `upto`) where it can differ.
   */
  amount?: string;
  errorReason?: string;
  errorMessage?: string;
  explorerUrl?: string;
}

export const PAYMENT_RESPONSE_HEADER = 'payment-response';
const ATOMIC_AMOUNT = /^[0-9]+$/;

/**
 * Validate the amount a facilitator reports for an `upto` payment. It is an untrusted receipt field:
 * it must be a non-negative integer string and must not exceed the maximum the payer signed.
 */
export function parseUptoSettlementAmount(amount: string, maximum: bigint): bigint {
  if (!ATOMIC_AMOUNT.test(amount)) {
    throw new Error("payment response: 'amount' must be a non-negative integer string");
  }
  const settled = BigInt(amount);
  if (settled > maximum) {
    throw new Error(`payment response: settlement amount ${settled} exceeds authorized maximum ${maximum}`);
  }
  return settled;
}

export function decodePaymentReceipt(headerValue: string, network?: PaymentNetwork, expected?: { amount: string }): PaymentReceipt {
  const r = decodePaymentResponseHeader(headerValue) as Record<string, unknown>;
  if (r.amount !== undefined && (typeof r.amount !== 'string' || !ATOMIC_AMOUNT.test(r.amount))) {
    throw new Error("payment response: 'amount' must be a non-negative integer string");
  }
  const transaction = typeof r.transaction === 'string' && r.transaction.length > 0 ? r.transaction : undefined;
  return {
    success: r.success === true,
    transaction,
    network: typeof r.network === 'string' ? r.network : '',
    payer: typeof r.payer === 'string' ? r.payer : undefined,
    amount: typeof r.amount === 'string' ? r.amount : r.success === true ? expected?.amount : undefined,
    errorReason: typeof r.errorReason === 'string' ? r.errorReason : undefined,
    errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : undefined,
    explorerUrl: transaction && network ? explorerTxUrl(network, transaction) : undefined,
  };
}

/** Read the payment receipt from a Response (or Headers), if the server attached one. */
export function getPaymentReceipt(source: Response | Headers, network?: PaymentNetwork): PaymentReceipt | undefined {
  const headers = source instanceof Headers ? source : source.headers;
  const v = headers.get(PAYMENT_RESPONSE_HEADER) ?? headers.get('x-payment-response');
  if (!v) return undefined;
  try {
    return decodePaymentReceipt(v, network);
  } catch {
    return undefined;
  }
}
