import { createPublicClient, custom, numberToHex, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { deriveNativeBalance, getNativeBalance, nativeBalanceBytecode } from '../src/lib/balance.js';

const OWNER = '0x4f2d8a3b1c0e5d9b8e7a6c5d4e3f2a1b0c9d8e7f' as Address;

describe('nativeBalanceBytecode', () => {
  it('is PUSH20 <addr> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN', () => {
    expect(nativeBalanceBytecode(OWNER)).toBe(`0x73${OWNER.slice(2)}3160005260206000f3`);
    expect(() => nativeBalanceBytecode('0x12' as Address)).toThrow(/Not a valid address/);
  });
});

describe('getNativeBalance', () => {
  it('sends the init code as an eth_call with no `to` and decodes the word', async () => {
    const seen: unknown[] = [];
    const client = createPublicClient({
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            seen.push([method, params]);
            if (method === 'eth_call') return numberToHex(2_345_678n * 10n ** 12n, { size: 32 });
            throw new Error(`unexpected ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    });
    expect(await getNativeBalance(client, OWNER)).toBe(2_345_678n * 10n ** 12n);
    expect(seen).toEqual([['eth_call', [{ data: nativeBalanceBytecode(OWNER) }, 'latest']]]);
  });

  it('rejects a node that answers with something other than a word', async () => {
    const client = createPublicClient({
      transport: custom({ async request() { return '0x'; } }, { retryCount: 0 }),
    });
    await expect(getNativeBalance(client, OWNER)).rejects.toThrow(/instead of a 32-byte word/);
  });
});

describe('deriveNativeBalance', () => {
  it('subtracts SBC rescaled to 18 decimals from the aggregate', () => {
    const aggregate = 12_345_678n * 10n ** 12n; // 12.345678 RUSD as eth_getBalance reports it
    expect(deriveNativeBalance(aggregate, 10_000_000n, 6)).toBe(2_345_678n * 10n ** 12n);
    expect(deriveNativeBalance(aggregate, 0n, 6)).toBe(aggregate);
  });
  it('never goes negative', () => {
    expect(deriveNativeBalance(10n ** 18n, 2_000_000n, 6)).toBe(0n);
  });
});
