import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP2612_TYPES, signPermit } from '../src/lib/x402/eip2612.js';
import { encodePermitPaymentHeader } from '../src/lib/x402/protocol.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ASSET = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' as Address;
const SPENDER = '0x2c88F72487690c5F4C933c7b519027D787F00DA7' as Address;

describe('signPermit', () => {
  it('produces a v/r/s signature recoverable to the owner', async () => {
    const account = privateKeyToAccount(PK);
    const permit = await signPermit(account, {
      asset: ASSET,
      chainId: 723487,
      name: 'Stable Coin',
      version: '1',
      spender: SPENDER,
      value: 1000n,
      nonce: 0n,
      deadline: 9999999999n,
    });

    expect(permit.kind).toBe('permit-eip2612');
    expect(permit.owner).toBe(account.address);
    expect(permit.spender).toBe(SPENDER);
    expect(permit.value).toBe('1000');
    expect(permit.nonce).toBe('0');
    expect(permit.deadline).toBe('9999999999');
    expect([27, 28]).toContain(permit.v);

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Stable Coin', version: '1', chainId: 723487, verifyingContract: ASSET },
      types: EIP2612_TYPES,
      primaryType: 'Permit',
      message: {
        owner: account.address,
        spender: SPENDER,
        value: 1000n,
        nonce: 0n,
        deadline: 9999999999n,
      },
      signature: { r: permit.r, s: permit.s, v: BigInt(permit.v) },
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe('encodePermitPaymentHeader', () => {
  it('emits the flat radius-flavor envelope with a permit payload', async () => {
    const account = privateKeyToAccount(PK);
    const permit = await signPermit(account, {
      asset: ASSET,
      chainId: 723487,
      name: 'Stable Coin',
      version: '1',
      spender: SPENDER,
      value: 1000n,
      nonce: 0n,
      deadline: 9999999999n,
    });
    const header = encodePermitPaymentHeader({
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:723487',
      payload: permit,
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('eip155:723487');
    expect(decoded.payload.kind).toBe('permit-eip2612');
    expect(decoded.payload.owner).toBe(account.address);
    expect(decoded.payload.spender).toBe(SPENDER);
    expect(typeof decoded.payload.v).toBe('number');
    expect(decoded.payload.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decoded.payload.s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
