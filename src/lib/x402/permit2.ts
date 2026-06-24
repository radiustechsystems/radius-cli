import { randomBytes } from 'node:crypto';
import type { Address, Hex, PrivateKeyAccount } from 'viem';

// -- Single source of truth for the `upto` Permit2 constants ----------------------

// Canonical Uniswap Permit2, identical across EVM chains. Overridable for non-standard
// deployments via the optional permit2 argument to signPermit2Authorization.
// https://github.com/Uniswap/permit2
export const CANONICAL_PERMIT2_ADDRESS: Address =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// x402UptoPermit2Proxy — the authorized Permit2 spender for the `upto` scheme.
// Deterministic (CREATE2) on every EVM chain.
// Source: x402-foundation/x402 contracts/evm/src/x402UptoPermit2Proxy.sol
export const X402_UPTO_PERMIT2_PROXY: Address =
  '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

// EIP-712 type set for the `upto` permit. Confirmed against the deployed
// x402UptoPermit2Proxy: WITNESS_TYPEHASH = keccak256(
//   "Witness(address to,address facilitator,uint256 validAfter)"). The Witness
// member order (to, facilitator, validAfter) is load-bearing — do not reorder.
// viem derives the encoded type string and sorts referenced structs alphabetically
// (TokenPermissions < Witness), which matches Permit2's WITNESS_TYPE_STRING.
export const PERMIT2_UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

export const PERMIT2_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface Permit2Witness {
  to: Address;
  facilitator: Address;
  validAfter: number;
}

export interface Permit2Authorization {
  permitted: { token: Address; amount: bigint };
  from: Address;
  spender: Address;
  nonce: bigint;
  deadline: number;
  witness: Permit2Witness;
}

/** Random 256-bit Permit2 unordered nonce. */
export function randomPermit2Nonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

export function makePermit2Authorization(args: {
  from: Address;
  asset: Address;
  payTo: Address;
  facilitator: Address;
  maxAmount: bigint;
  maxTimeoutSeconds: number | undefined;
}): Permit2Authorization {
  const window = Math.min(Math.max(args.maxTimeoutSeconds ?? 600, 1), 600);
  const now = Math.floor(Date.now() / 1000);
  return {
    permitted: { token: args.asset, amount: args.maxAmount },
    from: args.from,
    spender: X402_UPTO_PERMIT2_PROXY,
    nonce: randomPermit2Nonce(),
    deadline: now + window,
    witness: { to: args.payTo, facilitator: args.facilitator, validAfter: now },
  };
}

/**
 * Sign the Permit2 `PermitWitnessTransferFrom` EIP-712 digest.
 *
 * The Permit2 domain is name-only: { name: "Permit2", chainId, verifyingContract }.
 * The canonical Permit2 contract has NO `version` field in its EIP712Domain, so we
 * deliberately omit it — adding one would change the domain separator and yield a
 * signature the facilitator/contract rejects.
 */
export async function signPermit2Authorization(
  account: PrivateKeyAccount,
  args: { chainId: number; authorization: Permit2Authorization; permit2?: Address },
): Promise<Hex> {
  const a = args.authorization;
  return await account.signTypedData({
    domain: {
      name: 'Permit2',
      chainId: args.chainId,
      verifyingContract: args.permit2 ?? CANONICAL_PERMIT2_ADDRESS,
    },
    types: PERMIT2_UPTO_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: a.permitted.token, amount: a.permitted.amount },
      spender: a.spender,
      nonce: a.nonce,
      deadline: BigInt(a.deadline),
      witness: {
        to: a.witness.to,
        facilitator: a.witness.facilitator,
        validAfter: BigInt(a.witness.validAfter),
      },
    },
  });
}
