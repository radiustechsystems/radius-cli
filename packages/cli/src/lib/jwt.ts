import { sha256, toBytes, type Address, type Hex } from 'viem';

/** Default lifetime of a signed JWT: 5 minutes, enough for one agent-to-agent request. */
export const DEFAULT_JWT_EXPIRES_IN = 300;

/** What `signJwt` needs from an account: viem's `PrivateKeyAccount` (`sign` is raw-hash signing). */
export interface JwtSigner {
  address: Address;
  publicKey: Hex;
  sign: (args: { hash: Hex }) => Promise<Hex>;
}

export interface SignJwtOptions {
  /** Claims to sign. `iat`, `exp` and `iss` are filled in when absent. */
  payload: Record<string, unknown>;
  /** Chain the default `did:pkh` issuer names. */
  chainId: number;
  /** Override `iss` (default: the payload's, else `did:pkh:eip155:<chainId>:<address>`). */
  iss?: string;
  /** Header `kid` (default: `<iss>#controller`). */
  kid?: string;
  /** Seconds until `exp` (default: the payload's `exp`, else 300). */
  expiresIn?: number;
  /** Current time in seconds (tests). */
  now?: number;
}

export interface SignedJwt {
  token: string;
  header: { alg: 'ES256K'; typ: 'JWT'; kid: string };
  payload: Record<string, unknown>;
  /** The signer's public key as a JWK, for a DID document or a verifier's allowlist. */
  jwk: { kty: 'EC'; crv: 'secp256k1'; x: string; y: string };
}

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');

/** The signer's uncompressed secp256k1 public key as a JWK. */
export function publicKeyJwk(publicKey: Hex): SignedJwt['jwk'] {
  const raw = toBytes(publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('expected an uncompressed secp256k1 public key');
  return { kty: 'EC', crv: 'secp256k1', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) };
}

/**
 * Sign a compact JWS with `alg: ES256K` (RFC 8812): ECDSA secp256k1 over SHA-256 of
 * `header.payload`, the signature being `r || s` (64 bytes, low-s), not DER and not the 65-byte
 * Ethereum form. The key stays in the account; nothing here sees it.
 */
export async function signJwt(account: JwtSigner, options: SignJwtOptions): Promise<SignedJwt> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: `did:pkh:eip155:${options.chainId}:${account.address}`,
    iat: now,
    ...options.payload,
  };
  if (options.iss !== undefined) claims.iss = options.iss;
  const iat = typeof claims.iat === 'number' ? claims.iat : now;
  if (options.expiresIn !== undefined) claims.exp = iat + options.expiresIn;
  else if (claims.exp === undefined) claims.exp = iat + DEFAULT_JWT_EXPIRES_IN;

  const header = { alg: 'ES256K' as const, typ: 'JWT' as const, kid: options.kid ?? `${String(claims.iss)}#controller` };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await account.sign({ hash: sha256(toBytes(signingInput)) });
  // viem serializes r (32) || s (32) || v (1); JWS wants r || s.
  const rs = toBytes(signature).subarray(0, 64);
  return { token: `${signingInput}.${b64url(rs)}`, header, payload: claims, jwk: publicKeyJwk(account.publicKey) };
}
