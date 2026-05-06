import { describe, it, expect } from 'vitest';
import {
  decodePaymentResponse,
  encodePaymentHeader,
  networkIdForChain,
  parseChallenge,
  pickAccept,
} from '../src/lib/x402/protocol.js';

const VALID_CHALLENGE = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:723487',
      asset: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxAmountRequired: '13000',
      resource: '/example',
      description: 'access fee',
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
      extra: { name: 'SBC', version: '2' },
    },
  ],
  error: 'X-PAYMENT required',
};

describe('parseChallenge', () => {
  it('accepts a spec-shaped challenge', () => {
    const c = parseChallenge(VALID_CHALLENGE);
    expect(c.x402Version).toBe(1);
    expect(c.accepts).toHaveLength(1);
    expect(c.accepts[0].maxAmountRequired).toBe(13000n);
    expect(c.accepts[0].extra?.version).toBe('2');
    expect(c.error).toBe('X-PAYMENT required');
  });

  it('rejects non-objects', () => {
    expect(() => parseChallenge(null)).toThrow();
    expect(() => parseChallenge([])).toThrow();
    expect(() => parseChallenge('hi')).toThrow();
  });

  it('rejects missing version', () => {
    expect(() => parseChallenge({ accepts: VALID_CHALLENGE.accepts })).toThrow(/x402Version/);
  });

  it('rejects empty accepts', () => {
    expect(() => parseChallenge({ x402Version: 1, accepts: [] })).toThrow(/accepts/);
  });

  it('rejects bad address', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CHALLENGE));
    bad.accepts[0].asset = '0xnope';
    expect(() => parseChallenge(bad)).toThrow(/asset/);
  });

  it('rejects negative amount', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CHALLENGE));
    bad.accepts[0].maxAmountRequired = '-1';
    expect(() => parseChallenge(bad)).toThrow(/maxAmountRequired/);
  });
});

describe('pickAccept', () => {
  it('matches the configured chain id', () => {
    const c = parseChallenge(VALID_CHALLENGE);
    const a = pickAccept(c.accepts, 723487);
    expect(a?.payTo).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('returns undefined on mismatch', () => {
    const c = parseChallenge(VALID_CHALLENGE);
    expect(pickAccept(c.accepts, 1)).toBeUndefined();
  });

  it('skips non-exact schemes', () => {
    const challenge = {
      x402Version: 1,
      accepts: [
        { ...VALID_CHALLENGE.accepts[0], scheme: 'subscription' },
        { ...VALID_CHALLENGE.accepts[0] },
      ],
    };
    const c = parseChallenge(challenge);
    const a = pickAccept(c.accepts, 723487);
    expect(a?.scheme).toBe('exact');
  });
});

describe('networkIdForChain', () => {
  it('formats CAIP-2 ids', () => {
    expect(networkIdForChain(723487)).toBe('eip155:723487');
    expect(networkIdForChain(1)).toBe('eip155:1');
  });
});

describe('encodePaymentHeader / decodePaymentResponse', () => {
  it('round-trips a payment header through base64 + JSON', () => {
    const header = encodePaymentHeader({
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:723487',
      payload: {
        signature: '0xdeadbeef',
        authorization: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0x0000000000000000000000000000000000000002',
          value: 13000n,
          validAfter: 0,
          validBefore: 1234567890,
          nonce: '0xaa',
        },
      },
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('exact');
    expect(decoded.payload.authorization.value).toBe('13000');
    expect(decoded.payload.authorization.validBefore).toBe(1234567890);
  });

  it('decodes a payment-response header', () => {
    const body = {
      success: true,
      transaction: '0xabc',
      network: 'eip155:723487',
      payer: '0x0000000000000000000000000000000000000003',
      errorReason: null,
    };
    const header = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
    const decoded = decodePaymentResponse(header);
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe('0xabc');
    expect(decoded.payer).toBe('0x0000000000000000000000000000000000000003');
  });
});
