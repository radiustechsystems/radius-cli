import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

describe('sign / verify (EIP-191)', () => {
  it('signs a string message and verifies against the signer', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = 'hello radius';
    const sig = await account.signMessage({ message });
    expect(await verifyMessage({ address: account.address, message, signature: sig })).toBe(true);
  });

  it('verify returns false for the wrong address', async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const message = 'hello';
    const sig = await a.signMessage({ message });
    expect(await verifyMessage({ address: b.address, message, signature: sig })).toBe(false);
  });

  it('round-trips raw hex messages', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = { raw: '0xdeadbeef' as `0x${string}` };
    const sig = await account.signMessage({ message });
    expect(await verifyMessage({ address: account.address, message, signature: sig })).toBe(true);
  });
});
