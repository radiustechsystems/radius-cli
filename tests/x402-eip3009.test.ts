import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP3009_TYPES, signTransferAuthorization } from '../src/lib/x402/eip3009.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ASSET = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' as Address;

describe('signTransferAuthorization', () => {
  it('produces a signature recoverable to the signer address', async () => {
    const account = privateKeyToAccount(PK);
    const auth = {
      from: account.address,
      to: '0x000000000000000000000000000000000000dEaD' as Address,
      value: 13000n,
      validAfter: 0,
      validBefore: 9999999999,
      nonce: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex,
    };

    const signature = await signTransferAuthorization(account, {
      asset: ASSET,
      chainId: 723487,
      name: 'SBC',
      version: '1',
      authorization: auth,
    });

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'SBC', version: '1', chainId: 723487, verifyingContract: ASSET },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('does not recover to a different signer', async () => {
    const a = privateKeyToAccount(PK);
    const b = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
    const auth = {
      from: a.address,
      to: '0x000000000000000000000000000000000000dEaD' as Address,
      value: 1n,
      validAfter: 0,
      validBefore: 9999999999,
      nonce: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
    };
    const signature = await signTransferAuthorization(a, {
      asset: ASSET,
      chainId: 723487,
      name: 'SBC',
      version: '1',
      authorization: auth,
    });
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'SBC', version: '1', chainId: 723487, verifyingContract: ASSET },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });
    expect(recovered.toLowerCase()).not.toBe(b.address.toLowerCase());
  });
});
