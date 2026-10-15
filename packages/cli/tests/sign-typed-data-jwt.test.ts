import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverAddress, recoverTypedDataAddress, sha256, toBytes, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerWallet } from '../src/commands/wallet.js';
import { signJwt } from '../src/lib/jwt.js';
import { parseTypedData } from '../src/lib/typedData.js';

async function run(...args: string[]): Promise<string> {
  const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--private-key <hex>').option('--sbc <address>').option('--rusd <address>').option('--json');
  registerWallet(program);
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
  try {
    await program.parseAsync(['node', 'radius-cli', ...args]);
  } finally {
    log.mockRestore();
  }
  return out;
}

// An EIP-3009 TransferWithAuthorization as a wallet RPC would receive it: integers as strings.
const transferAuth = {
  domain: { name: 'Stable Coin', version: '1', chainId: '72344', verifyingContract: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: '0x000000000000000000000000000000000000bEEF',
    to: '0x000000000000000000000000000000000000dEaD',
    value: '1000',
    validAfter: 0,
    validBefore: '0x7fffffff',
    nonce: `0x${'11'.repeat(32)}`,
  },
};

describe('parseTypedData', () => {
  it('converts JSON integers (numbers, decimal and hex strings) to bigints', () => {
    const td = parseTypedData(transferAuth);
    expect(td.domain).toMatchObject({ chainId: 72344 });
    expect(td.message).toMatchObject({ value: 1000n, validAfter: 0n, validBefore: 0x7fffffffn });
  });

  it('converts integers inside nested structs and arrays', () => {
    const td = parseTypedData({
      domain: { name: 'X' },
      types: { Item: [{ name: 'n', type: 'uint8' }], Order: [{ name: 'items', type: 'Item[]' }, { name: 'amount', type: 'int256' }] },
      primaryType: 'Order',
      message: { items: [{ n: '1' }, { n: 2 }], amount: '-5' },
    });
    expect(td.message).toEqual({ items: [{ n: 1n }, { n: 2n }], amount: -5n });
  });

  it.each([
    ['no types', { primaryType: 'A', message: {} }, /types must be an object/],
    ['an unknown primaryType', { types: { A: [] }, primaryType: 'B', message: {} }, /primaryType must name one of types/],
    ['a missing field', { types: { A: [{ name: 'x', type: 'uint256' }] }, primaryType: 'A', message: {} }, /message.x is missing/],
    ['a non-integer uint', { types: { A: [{ name: 'x', type: 'uint256' }] }, primaryType: 'A', message: { x: '1.5' } }, /message.x must be an integer/],
  ])('rejects %s', (_name, input, error) => {
    expect(() => parseTypedData(input)).toThrow(error);
  });
});

describe('wallet sign-typed-data', () => {
  it('signs typed data from a file; the signature recovers to the wallet address', async () => {
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);
    const file = join(mkdtempSync(join(tmpdir(), 'radius-cli-')), 'typed.json');
    writeFileSync(file, JSON.stringify(transferAuth));

    const out = JSON.parse(await run('--private-key', key, '--json', 'wallet', 'sign-typed-data', `@${file}`));

    expect(out.address).toBe(address);
    const recovered = await recoverTypedDataAddress({ ...parseTypedData(transferAuth), signature: out.signature as Hex });
    expect(recovered).toBe(address);
  });

  it('matches viem signing the same data with bigints', async () => {
    const key = generatePrivateKey();
    const sig = (await run('--private-key', key, 'wallet', 'sign-typed-data', JSON.stringify(transferAuth))).trim();
    const expected = await privateKeyToAccount(key).signTypedData({
      domain: { ...transferAuth.domain, chainId: 72344, verifyingContract: transferAuth.domain.verifyingContract as Hex },
      types: transferAuth.types,
      primaryType: 'TransferWithAuthorization',
      message: { ...transferAuth.message, value: 1000n, validAfter: 0n, validBefore: 0x7fffffffn },
    });
    expect(sig).toBe(expected);
  });
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('signJwt (ES256K)', () => {
  it('produces a JWS that verifies with the wallet public key and recovers to its address', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token, jwk } = await signJwt(account, { payload: { sub: 'agent' }, chainId: 72344, now: 1_700_000_000 });
    const [h, p, s] = token.split('.');

    expect(decode(h)).toEqual({ alg: 'ES256K', typ: 'JWT', kid: `did:pkh:eip155:72344:${account.address}#controller` });
    expect(decode(p)).toEqual({ iss: `did:pkh:eip155:72344:${account.address}`, iat: 1_700_000_000, exp: 1_700_000_300, sub: 'agent' });

    // An independent ES256K verifier (OpenSSL via node:crypto) accepts the raw r||s signature.
    const sig = Buffer.from(s, 'base64url');
    expect(sig).toHaveLength(64);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);

    // And r||s recovers to the wallet address with one of the two recovery ids.
    const hash = sha256(toBytes(`${h}.${p}`));
    const r = toHex(sig.subarray(0, 32));
    const sv = toHex(sig.subarray(32));
    const candidates = await Promise.all([0, 1].map((yParity) => recoverAddress({ hash, signature: { r, s: sv, yParity } })));
    expect(candidates).toContain(account.address);
  });

  it('keeps payload claims, and lets --iss / --kid / --expires-in override them', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fromPayload = await signJwt(account, { payload: { iss: 'did:web:a.example', iat: 10, exp: 20 }, chainId: 1, now: 99 });
    expect(fromPayload.payload).toMatchObject({ iss: 'did:web:a.example', iat: 10, exp: 20 });
    expect(fromPayload.header.kid).toBe('did:web:a.example#controller');

    const overridden = await signJwt(account, { payload: { iss: 'x', exp: 20 }, chainId: 1, iss: 'did:web:b.example', kid: 'k1', expiresIn: 60, now: 100 });
    expect(overridden.payload).toMatchObject({ iss: 'did:web:b.example', iat: 100, exp: 160 });
    expect(overridden.header.kid).toBe('k1');
  });
});

describe('wallet sign-jwt', () => {
  it('prints a token signed by the wallet, defaulting iss to the configured chain', async () => {
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);
    const out = JSON.parse(await run('--network', 'testnet', '--private-key', key, '--json', 'wallet', 'sign-jwt', '{"aud":"https://agent.example"}', '--expires-in', '60'));
    expect(out.address).toBe(address);
    expect(out.payload).toMatchObject({ iss: `did:pkh:eip155:72344:${address}`, aud: 'https://agent.example' });
    expect(out.payload.exp - out.payload.iat).toBe(60);
    const [h, p, s] = (out.token as string).split('.');
    const pub = createPublicKey({ key: out.jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it.each([
    ['a non-object payload', ['wallet', 'sign-jwt', '[1]'], /must be a JSON object/],
    ['invalid JSON', ['wallet', 'sign-jwt', '{nope'], /JWT payload must be JSON/],
    ['a bad --expires-in', ['wallet', 'sign-jwt', '--expires-in', '0'], /--expires-in must be a positive integer/],
  ])('rejects %s', async (_name, args, error) => {
    await expect(run('--private-key', generatePrivateKey(), ...args)).rejects.toThrow(error);
  });
});
