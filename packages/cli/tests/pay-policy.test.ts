import { describe, it, expect } from 'vitest';
import { decidePayment } from '../src/lib/payPolicy.js';

describe('decidePayment', () => {
  it('auto-pays with --yes regardless of amount when no threshold is set', () => {
    expect(decidePayment({ yes: true }, 10n ** 9n, 6, false)).toBe('auto-pay');
    expect(decidePayment({ yes: true }, 10n ** 9n, 6, true)).toBe('auto-pay');
  });

  it('keeps the threshold as a cap when --yes is also given', () => {
    expect(decidePayment({ yes: true, threshold: '0.05' }, 50000n, 6, false)).toBe('auto-pay');
    expect(decidePayment({ yes: true, threshold: '0.05' }, 50001n, 6, false)).toBe('refuse-over-threshold');
    expect(decidePayment({ yes: true, threshold: '0.05' }, 50001n, 6, true)).toBe('refuse-over-threshold');
  });

  it('auto-pays when the offer is at or below the threshold (display units)', () => {
    expect(decidePayment({ threshold: '0.05' }, 50000n, 6, false)).toBe('auto-pay');
    expect(decidePayment({ threshold: '0.05' }, 49999n, 6, false)).toBe('auto-pay');
  });

  it('prompts above the threshold on a TTY and refuses without one', () => {
    expect(decidePayment({ threshold: '0.05' }, 50001n, 6, true)).toBe('prompt');
    expect(decidePayment({ threshold: '0.05' }, 50001n, 6, false)).toBe('refuse-no-tty');
  });

  it('prompts or refuses when no threshold is given', () => {
    expect(decidePayment({}, 1n, 6, true)).toBe('prompt');
    expect(decidePayment({}, 1n, 6, false)).toBe('refuse-no-tty');
  });

  it('rejects a malformed threshold', () => {
    expect(() => decidePayment({ threshold: 'lots' }, 1n, 6, true)).toThrow(/decimal number/);
  });
});
