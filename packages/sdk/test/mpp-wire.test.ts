/** MPP wire helpers checked against mppx, the reference implementation. */
import { describe, expect, it } from 'vitest';
import { Challenge, Credential, Receipt } from 'mppx';
import { challengeHash } from 'mppx/evm';
import {
  canonicalJson,
  encodeRequest,
  mppChallengeId,
  mppChallengeNonce,
  parseMppChallenges,
  parseMppCredential,
  parseMppReceipt,
  serializeMppChallenge,
  serializeMppCredential,
  serializeMppReceipt,
  type MppAuthorizationPayload,
} from '../src/mpp.js';

const SECRET = 'test-secret-with-at-least-32-bytes-of-entropy';
const REQUEST = {
  amount: '1000',
  currency: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
  recipient: '0x000000000000000000000000000000000000dEaD',
  methodDetails: { chainId: 72344, credentialTypes: ['authorization'], decimals: 6 },
};
const PAYLOAD: MppAuthorizationPayload = {
  type: 'authorization',
  from: '0x1111111111111111111111111111111111111111',
  to: REQUEST.recipient,
  value: '1000',
  validAfter: '0',
  validBefore: '1900000000',
  nonce: `0x${'00'.repeat(32)}`,
  signature: '0xsig',
};

function mppxChallenge(extra: Record<string, unknown> = {}) {
  return Challenge.from(
    { realm: 'seller.test', method: 'evm', intent: 'charge', request: REQUEST, expires: '2030-01-01T00:00:00.000Z', description: 'A “quoted” lookup', secretKey: SECRET, ...extra } as never,
  );
}

describe('MPP wire format against mppx', () => {
  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('parses challenges mppx serializes, including several in one header and escaped values', () => {
    const one = mppxChallenge();
    const two = mppxChallenge({ request: { ...REQUEST, methodDetails: { ...REQUEST.methodDetails, chainId: 84532 } }, opaque: 'b3BhcXVl' });
    const header = `Bearer realm="x", ${Challenge.serialize(one)}, ${Challenge.serialize(two)}`;
    const parsed = parseMppChallenges(header);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: one.id, realm: 'seller.test', method: 'evm', intent: 'charge', request: REQUEST, expires: one.expires, description: 'A “quoted” lookup' });
    expect(parsed[1]).toMatchObject({ id: two.id, opaque: 'b3BhcXVl' });
    expect(parsed[1].request).toMatchObject({ methodDetails: { chainId: 84532 } });
    expect(parseMppChallenges(null)).toEqual([]);
    expect(parseMppChallenges('Payment id="x"')).toEqual([]);
  });

  it('serializes challenges mppx parses, with the HMAC id mppx computes', async () => {
    const fields = { realm: 'seller.test', method: 'evm', intent: 'charge', request: REQUEST, requestEncoded: encodeRequest(REQUEST), expires: '2030-01-01T00:00:00.000Z', description: 'A “quoted” lookup' };
    const id = await mppChallengeId(SECRET, fields);
    expect(id).toBe(mppxChallenge().id);
    const back = Challenge.deserialize(serializeMppChallenge({ id, ...fields }));
    expect(back).toMatchObject({ id, realm: 'seller.test', request: REQUEST, description: 'A “quoted” lookup' });
    expect(Challenge.verify(back, { secretKey: SECRET })).toBe(true);
    // opaque and digest are bound too.
    const withOpaque = { ...fields, opaque: 'b3BhcXVl', digest: 'sha-256=abc' };
    expect(await mppChallengeId(SECRET, withOpaque)).toBe(mppxChallenge({ opaque: 'b3BhcXVl', digest: 'sha-256=abc' }).id);
  });

  it('derives the EIP-3009 nonce from the challenge like mppx', () => {
    const c = mppxChallenge();
    expect(mppChallengeNonce(c)).toBe(challengeHash(c));
  });

  it('round-trips credentials with mppx in both directions', () => {
    const c = mppxChallenge({ opaque: 'b3BhcXVl' });
    const ours = parseMppChallenges(Challenge.serialize(c))[0];
    const header = serializeMppCredential(ours, PAYLOAD, 'did:pkh:eip155:72344:0x1111111111111111111111111111111111111111');
    const theirs = Credential.deserialize(header);
    expect(theirs.challenge).toMatchObject({ id: c.id, realm: c.realm, request: REQUEST, opaque: 'b3BhcXVl', expires: c.expires });
    expect(theirs.payload).toEqual(PAYLOAD);
    expect(Challenge.verify(theirs.challenge, { secretKey: SECRET })).toBe(true);
    const back = parseMppCredential(Credential.serialize(Credential.from({ challenge: c, payload: PAYLOAD, source: 'did:pkh:eip155:72344:0x1' })));
    expect(back).toMatchObject({ challenge: { id: c.id, realm: c.realm, request: REQUEST, opaque: 'b3BhcXVl' }, payload: PAYLOAD, source: 'did:pkh:eip155:72344:0x1' });
    expect(parseMppCredential('Bearer abc')).toBeUndefined();
    expect(() => parseMppCredential('Payment not-json')).toThrow();
  });

  it('round-trips receipts with mppx', () => {
    const r = { method: 'evm', reference: `0x${'ab'.repeat(32)}`, status: 'success' as const, timestamp: '2026-10-09T12:00:00.000Z' };
    expect(Receipt.deserialize(serializeMppReceipt(r))).toMatchObject(r);
    expect(parseMppReceipt(Receipt.serialize(Receipt.from(r)))).toMatchObject(r);
    expect(() => parseMppReceipt(serializeMppReceipt({ ...r, status: 'failed' as never }))).toThrow();
  });
});
