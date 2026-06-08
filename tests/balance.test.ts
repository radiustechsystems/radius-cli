import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'viem';
import { splitAggregateBalance } from '../src/lib/balance.js';

const SBC_DECIMALS = 6;

describe('splitAggregateBalance', () => {
  it('does not double-count SBC included in the aggregate', () => {
    // 0.1 SBC, no raw native: eth_getBalance returns 0.1 (token × rate).
    const { totalWei, sbcAsWei, nativeWei } = splitAggregateBalance({
      aggregateWei: parseEther('0.1'),
      sbcRaw: parseUnits('0.1', SBC_DECIMALS),
      sbcDecimals: SBC_DECIMALS,
    });
    expect(totalWei).toBe(parseEther('0.1'));
    expect(sbcAsWei).toBe(parseEther('0.1'));
    expect(nativeWei).toBe(0n);
  });

  it('derives the raw-native remainder when both are held', () => {
    const { nativeWei } = splitAggregateBalance({
      aggregateWei: parseEther('0.25'),
      sbcRaw: parseUnits('0.1', SBC_DECIMALS),
      sbcDecimals: SBC_DECIMALS,
    });
    expect(nativeWei).toBe(parseEther('0.15'));
  });

  it('clamps the native remainder at zero if the rate drifts below peg', () => {
    const { nativeWei } = splitAggregateBalance({
      aggregateWei: parseEther('0.09'),
      sbcRaw: parseUnits('0.1', SBC_DECIMALS),
      sbcDecimals: SBC_DECIMALS,
    });
    expect(nativeWei).toBe(0n);
  });

  it('handles zero balances', () => {
    const { totalWei, sbcAsWei, nativeWei } = splitAggregateBalance({
      aggregateWei: 0n,
      sbcRaw: 0n,
      sbcDecimals: SBC_DECIMALS,
    });
    expect(totalWei).toBe(0n);
    expect(sbcAsWei).toBe(0n);
    expect(nativeWei).toBe(0n);
  });

  it('scales correctly for 18-decimal tokens', () => {
    const { sbcAsWei } = splitAggregateBalance({
      aggregateWei: parseEther('1'),
      sbcRaw: parseEther('1'),
      sbcDecimals: 18,
    });
    expect(sbcAsWei).toBe(parseEther('1'));
  });
});
