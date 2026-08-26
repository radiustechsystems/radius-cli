import { describe, it, expect } from 'vitest';
import {
  chainIdForNetwork,
  decodePaymentResponse,
  encodePaymentHeader,
  hasSuccessfulPaymentResponse,
  networkIdForChain,
  networkMatchesChain,
  parseUptoSettlementAmount,
  parseChallenge,
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

// v2 renames maxAmountRequired -> amount and carries CAIP-2 networks.
const V2_UPTO_CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'upto',
      network: 'eip155:84532',
      asset: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
      payTo: '0x000000000000000000000000000000000000dEaD',
      amount: '500000',
      maxTimeoutSeconds: 120,
      extra: {
        name: 'USDC',
        version: '2',
        facilitatorAddress: '0x00000000000000000000000000000000fac11107',
      },
    },
  ],
  error: 'PAYMENT-SIGNATURE required',
};

describe('parseChallenge', () => {
  it('accepts a v1 (maxAmountRequired) challenge', () => {
    const c = parseChallenge(VALID_CHALLENGE);
    expect(c.x402Version).toBe(1);
    expect(c.accepts).toHaveLength(1);
    expect(c.accepts[0].maxAmountRequired).toBe(13000n);
    expect(c.accepts[0].extra?.version).toBe('2');
    expect(c.error).toBe('X-PAYMENT required');
  });

  it('accepts a v2 (amount) challenge and normalizes the amount', () => {
    const c = parseChallenge(V2_UPTO_CHALLENGE);
    expect(c.x402Version).toBe(2);
    expect(c.accepts[0].scheme).toBe('upto');
    expect(c.accepts[0].maxAmountRequired).toBe(500000n);
    expect(c.accepts[0].extra?.facilitatorAddress).toBe(
      '0x00000000000000000000000000000000fac11107',
    );
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

describe('CAIP-2 network parsing', () => {
  it('formats CAIP-2 ids', () => {
    expect(networkIdForChain(723487)).toBe('eip155:723487');
    expect(networkIdForChain(84532)).toBe('eip155:84532');
  });

  it('parses eip155:<id> back to a chain id', () => {
    expect(chainIdForNetwork('eip155:84532')).toBe(84532);
    expect(chainIdForNetwork('eip155:1')).toBe(1);
  });

  it('returns undefined for non-eip155 / malformed networks', () => {
    expect(chainIdForNetwork('solana:mainnet')).toBeUndefined();
    expect(chainIdForNetwork('eip155:')).toBeUndefined();
    expect(chainIdForNetwork('723487')).toBeUndefined();
  });

  it('matches a network string against a configured chain id', () => {
    expect(networkMatchesChain('eip155:84532', 84532)).toBe(true);
    expect(networkMatchesChain('eip155:84532', 1)).toBe(false);
  });
});

describe('encodePaymentHeader / decodePaymentResponse', () => {
  it('round-trips a v1 payment header through base64 + JSON', () => {
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

  it('decodes a v1 payment-response header', () => {
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

  it('decodes a v2 upto payment-response with the actual settled amount', () => {
    const body = {
      success: true,
      transaction: '',
      network: 'eip155:84532',
      payer: '0x0000000000000000000000000000000000000003',
      amount: '0',
    };
    const header = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
    const decoded = decodePaymentResponse(header);
    expect(decoded.success).toBe(true);
    expect(decoded.amount).toBe('0');
    expect(decoded.transaction).toBe('');
  });

  it('rejects a malformed payment-response amount', () => {
    const header = Buffer.from(JSON.stringify({ success: true, amount: '-1' }), 'utf8').toString('base64');
    expect(() => decodePaymentResponse(header)).toThrow(/non-negative integer/);
  });

  it('does not treat an unsuccessful receipt as settled', () => {
    const header = Buffer.from(JSON.stringify({ success: false, errorReason: 'settlement_failed' }), 'utf8')
      .toString('base64');
    expect(hasSuccessfulPaymentResponse(decodePaymentResponse(header))).toBe(false);
    expect(hasSuccessfulPaymentResponse(null)).toBe(false);
  });

  it('treats an explicit successful receipt as settled', () => {
    const header = Buffer.from(JSON.stringify({ success: true }), 'utf8').toString('base64');
    expect(hasSuccessfulPaymentResponse(decodePaymentResponse(header))).toBe(true);
  });
});

describe('parseUptoSettlementAmount', () => {
  it('accepts a zero or partial settlement within the authorized maximum', () => {
    expect(parseUptoSettlementAmount('0', 100n)).toBe(0n);
    expect(parseUptoSettlementAmount('60', 100n)).toBe(60n);
    expect(parseUptoSettlementAmount('100', 100n)).toBe(100n);
  });

  it('rejects malformed or negative settlement amounts', () => {
    expect(() => parseUptoSettlementAmount('-1', 100n)).toThrow(/non-negative integer/);
    expect(() => parseUptoSettlementAmount('1.5', 100n)).toThrow(/non-negative integer/);
    expect(() => parseUptoSettlementAmount('nope', 100n)).toThrow(/non-negative integer/);
  });

  it('rejects a settlement above the signed maximum', () => {
    expect(() => parseUptoSettlementAmount('101', 100n)).toThrow(/exceeds authorized maximum/);
  });
});
