import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildPermit2PaymentPayload,
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TYPES,
  randomPermit2Nonce,
  signPermit2WitnessTransfer,
  X402_PERMIT2_PROXY,
} from '../src/lib/x402/permit2.js';
import { signEip2612Permit } from '../src/lib/x402/eip2612.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SBC = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' as Address;
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;

describe('permit2 constants', () => {
  it('uses the canonical Permit2 and x402 proxy addresses from the radius skill', () => {
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(X402_PERMIT2_PROXY).toBe('0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
  });
});

describe('randomPermit2Nonce', () => {
  it('produces distinct 128-bit nonces', () => {
    const a = randomPermit2Nonce();
    const b = randomPermit2Nonce();
    expect(a).not.toBe(b);
    expect(a).toBeLessThan(2n ** 128n);
    expect(a).toBeGreaterThanOrEqual(0n);
  });
});

describe('signPermit2WitnessTransfer', () => {
  it('signature recovers to the payer under the skill typed data (no domain version)', async () => {
    const account = privateKeyToAccount(PK);
    const nonce = 12345n;
    const deadline = 9999999999n;
    const signature = await signPermit2WitnessTransfer(account, {
      token: SBC,
      chainId: 723487,
      amount: 1000n,
      payTo: PAY_TO,
      nonce,
      deadline,
    });
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: 723487, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT2_WITNESS_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: SBC, amount: 1000n },
        spender: X402_PERMIT2_PROXY,
        nonce,
        deadline,
        witness: { to: PAY_TO, validAfter: 0n },
      },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe('buildPermit2PaymentPayload', () => {
  it('matches the radius x402 skill payload structure field-for-field', async () => {
    const account = privateKeyToAccount(PK);
    const deadline = 9999999999n;
    const permit2Nonce = 777n;
    const eip2612Nonce = 0n;
    const eip2612Signature = await signEip2612Permit(account, {
      asset: SBC,
      chainId: 723487,
      name: 'Stable Coin',
      version: '1',
      spender: PERMIT2_ADDRESS,
      value: 1000n,
      nonce: eip2612Nonce,
      deadline,
    });
    const permit2Signature = await signPermit2WitnessTransfer(account, {
      token: SBC,
      chainId: 723487,
      amount: 1000n,
      payTo: PAY_TO,
      nonce: permit2Nonce,
      deadline,
    });
    const acceptedRaw = {
      scheme: 'exact',
      network: 'eip155:723487',
      amount: '1000',
      asset: SBC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: 'Stable Coin', version: '1', assetTransferMethod: 'permit2' },
    };
    const header = buildPermit2PaymentPayload({
      chainId: 723487,
      resource: { url: 'https://example.com/api/data' },
      accepted: acceptedRaw,
      token: SBC,
      amount: 1000n,
      owner: account.address,
      payTo: PAY_TO,
      permit2Signature,
      permit2Nonce,
      eip2612Signature,
      eip2612Nonce,
      deadline,
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('eip155:723487');
    expect(decoded.resource).toEqual({
      url: 'https://example.com/api/data',
      description: '',
      mimeType: 'application/json',
    });
    expect(decoded.accepted).toEqual(acceptedRaw);

    expect(decoded.payload.signature).toBe(permit2Signature);
    expect(decoded.payload.permit2Authorization).toEqual({
      permitted: { token: SBC, amount: '1000' },
      from: account.address,
      spender: X402_PERMIT2_PROXY,
      nonce: '777',
      deadline: '9999999999',
      witness: { to: PAY_TO, validAfter: '0' },
    });

    expect(decoded.extensions.eip2612GasSponsoring.info).toEqual({
      from: account.address,
      asset: SBC,
      spender: PERMIT2_ADDRESS,
      amount: '1000',
      nonce: '0',
      deadline: '9999999999',
      signature: eip2612Signature,
      version: '1',
    });
  });
});
