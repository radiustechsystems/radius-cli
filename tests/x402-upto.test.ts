import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseChallenge } from '../src/lib/x402/protocol.js';
import { selectHandler } from '../src/lib/x402/handlers.js';
import {
  CANONICAL_PERMIT2_ADDRESS,
  X402_UPTO_PERMIT2_PROXY,
  PERMIT2_UPTO_TYPES,
  makePermit2Authorization,
  signPermit2Authorization,
} from '../src/lib/x402/permit2.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ASSET = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' as Address;
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const FACILITATOR = '0x00000000000000000000000000000000fac11107' as Address;

const V2_UPTO_CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'upto',
      network: 'eip155:84532',
      asset: ASSET,
      payTo: PAY_TO,
      amount: '500000',
      maxTimeoutSeconds: 120,
      extra: { name: 'USDC', version: '2', facilitatorAddress: FACILITATOR },
    },
  ],
};

describe('selectHandler', () => {
  it('selects exact@v1 for an exact entry on the configured chain', () => {
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:723487',
          asset: ASSET,
          payTo: PAY_TO,
          maxAmountRequired: '13000',
        },
      ],
    });
    const h = selectHandler(c.accepts[0], 723487);
    expect(h?.scheme).toBe('exact');
    expect(h?.version).toBe(1);
  });

  it('selects upto@v2 — upto is no longer filtered out', () => {
    const c = parseChallenge(V2_UPTO_CHALLENGE);
    const h = selectHandler(c.accepts[0], 84532);
    expect(h?.scheme).toBe('upto');
    expect(h?.version).toBe(2);
  });

  it('returns undefined when no handler matches the chain', () => {
    const c = parseChallenge(V2_UPTO_CHALLENGE);
    expect(selectHandler(c.accepts[0], 1)).toBeUndefined();
  });

  it('returns undefined for an unsupported scheme', () => {
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        {
          scheme: 'subscription',
          network: 'eip155:723487',
          asset: ASSET,
          payTo: PAY_TO,
          maxAmountRequired: '1',
        },
      ],
    });
    expect(selectHandler(c.accepts[0], 723487)).toBeUndefined();
  });
});

describe('Permit2 constants', () => {
  it('uses the canonical Permit2 and the x402 upto proxy as spender', () => {
    expect(CANONICAL_PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(X402_UPTO_PERMIT2_PROXY).toBe('0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002');
  });

  it('orders the Witness members as (to, facilitator, validAfter)', () => {
    expect(PERMIT2_UPTO_TYPES.Witness.map((m) => m.name)).toEqual([
      'to',
      'facilitator',
      'validAfter',
    ]);
  });
});

describe('Permit2 typed-data signing', () => {
  it('produces a signature recoverable to the signer', async () => {
    const account = privateKeyToAccount(PK);
    const auth = makePermit2Authorization({
      from: account.address,
      asset: ASSET,
      payTo: PAY_TO,
      facilitator: FACILITATOR,
      maxAmount: 500000n,
      maxTimeoutSeconds: 120,
    });
    expect(auth.spender).toBe(X402_UPTO_PERMIT2_PROXY);
    expect(auth.permitted.amount).toBe(500000n);

    const signature = await signPermit2Authorization(account, { chainId: 84532, authorization: auth });

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: 84532, verifyingContract: CANONICAL_PERMIT2_ADDRESS },
      types: PERMIT2_UPTO_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: auth.permitted.token, amount: auth.permitted.amount },
        spender: auth.spender,
        nonce: auth.nonce,
        deadline: BigInt(auth.deadline),
        witness: {
          to: auth.witness.to,
          facilitator: auth.witness.facilitator,
          validAfter: BigInt(auth.witness.validAfter),
        },
      },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe('upto payload encoding', () => {
  it('emits PAYMENT-SIGNATURE with the spec-shaped permit2Authorization', async () => {
    const account = privateKeyToAccount(PK);
    const c = parseChallenge(V2_UPTO_CHALLENGE);
    const handler = selectHandler(c.accepts[0], 84532)!;
    const built = await handler.buildPayload(c.accepts[0], {
      account,
      chainId: 84532,
      x402Version: 2,
      assetName: 'USDC',
      assetVersion: '2',
      amount: 500000n,
      url: 'https://api.example.com/r',
    });

    expect(built.headerName).toBe('payment-signature');
    const decoded = JSON.parse(Buffer.from(built.headerValueBase64, 'base64').toString('utf8'));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe('https://api.example.com/r');
    expect(decoded.accepted.scheme).toBe('upto');
    expect(decoded.accepted.amount).toBe('500000');
    // accepted.extra is reduced to {name, version}.
    expect(decoded.accepted.extra).toEqual({ name: 'USDC', version: '2' });

    const p = decoded.payload;
    expect(p.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(p.permit2Authorization.permitted).toEqual({ token: ASSET, amount: '500000' });
    expect(p.permit2Authorization.spender).toBe(X402_UPTO_PERMIT2_PROXY);
    expect(p.permit2Authorization.from).toBe(account.address);
    expect(p.permit2Authorization.witness.to).toBe(PAY_TO);
    expect(p.permit2Authorization.witness.facilitator).toBe(FACILITATOR);
    // amounts/nonce/deadline/validAfter are JSON strings.
    expect(typeof p.permit2Authorization.nonce).toBe('string');
    expect(typeof p.permit2Authorization.deadline).toBe('string');
    expect(typeof p.permit2Authorization.witness.validAfter).toBe('string');
  });

  it('fails clearly when the 402 extra omits the facilitator address', async () => {
    const account = privateKeyToAccount(PK);
    const noFac = JSON.parse(JSON.stringify(V2_UPTO_CHALLENGE));
    delete noFac.accepts[0].extra.facilitatorAddress;
    const c = parseChallenge(noFac);
    const handler = selectHandler(c.accepts[0], 84532)!;
    await expect(
      handler.buildPayload(c.accepts[0], {
        account,
        chainId: 84532,
        x402Version: 2,
        assetName: 'USDC',
        assetVersion: '2',
        amount: 500000n,
        url: 'https://api.example.com/r',
      }),
    ).rejects.toThrow(/facilitatorAddress/);
  });
});
