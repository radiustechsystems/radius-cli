import { parseSignature, type Address, type Hex, type LocalAccount, type PublicClient } from 'viem';

/**
 * EIP-2612 permit support for x402 settlement on Radius.
 *
 * SBC (the Radius-native stablecoin) does not implement EIP-3009
 * transferWithAuthorization, so Radius x402 servers settle via EIP-2612:
 * the client signs a `Permit(owner, spender, value, nonce, deadline)` for
 * the server's settlement spender, and the facilitator calls `permit()`
 * followed by `transferFrom()`. Servers advertise this with
 * `extra.settlementMethod: "permit-transferFrom"` and
 * `extra.settlementSpender` in the 402 challenge.
 */

export const EIP2612_NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const EIP2612_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// type alias (not interface) so it satisfies the encoder's index signature
export type PermitPayload = {
  kind: 'permit-eip2612';
  owner: Address;
  spender: Address;
  value: string;
  nonce: string;
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
};

export async function readPermitNonce(
  client: PublicClient,
  asset: Address,
  owner: Address,
): Promise<bigint> {
  return await client.readContract({
    address: asset,
    abi: EIP2612_NONCES_ABI,
    functionName: 'nonces',
    args: [owner],
  });
}

export interface Eip2612SignArgs {
  asset: Address;
  chainId: number;
  name: string;
  version: string;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** Raw EIP-2612 Permit signature — used directly by the permit2 gas-sponsoring extension. */
export async function signEip2612Permit(
  account: LocalAccount,
  args: Eip2612SignArgs,
): Promise<Hex> {
  return await account.signTypedData({
    domain: {
      name: args.name,
      version: args.version,
      chainId: args.chainId,
      verifyingContract: args.asset,
    },
    types: EIP2612_TYPES,
    primaryType: 'Permit',
    message: {
      owner: account.address,
      spender: args.spender,
      value: args.value,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  });
}

export async function signPermit(
  account: LocalAccount,
  args: Eip2612SignArgs,
): Promise<PermitPayload> {
  const signature = await signEip2612Permit(account, args);
  const { v, r, s } = parseSignature(signature);
  return {
    kind: 'permit-eip2612',
    owner: account.address,
    spender: args.spender,
    value: args.value.toString(),
    nonce: args.nonce.toString(),
    deadline: args.deadline.toString(),
    v: Number(v),
    r,
    s,
  };
}
