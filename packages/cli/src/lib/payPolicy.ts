import { parseUnits } from 'viem';

export interface PayPolicyFlags {
  yes?: boolean;
  threshold?: string;
}

export type PayDecision = 'auto-pay' | 'prompt' | 'refuse-no-tty' | 'refuse-over-threshold';

/**
 * Decide how to treat an x402 offer: pay silently, ask, or refuse. `amount` is the atomic
 * amount (the authorized maximum for `upto`).
 *
 * `--threshold` is a cap: at or below it the offer is paid without asking. Above it,
 * `--yes` refuses rather than pays (the flag means "don't ask", not "ignore the cap"); without
 * `--yes` a TTY is asked and a non-TTY run refuses. With no threshold, `--yes` pays anything.
 */
export function decidePayment(
  flags: PayPolicyFlags,
  amount: bigint,
  decimals: number,
  isTTY: boolean,
): PayDecision {
  if (flags.threshold !== undefined) {
    let limit: bigint;
    try {
      limit = parseUnits(flags.threshold, decimals);
    } catch {
      throw new Error(`--threshold must be a decimal number, got: ${flags.threshold}`);
    }
    if (limit >= amount) return 'auto-pay';
    if (flags.yes) return 'refuse-over-threshold';
  } else if (flags.yes) {
    return 'auto-pay';
  }
  return isTTY ? 'prompt' : 'refuse-no-tty';
}
