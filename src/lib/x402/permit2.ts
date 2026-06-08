import { randomBytes } from 'node:crypto';
import type { Address, Hex, LocalAccount } from 'viem';

/**
 * Official Radius x402 v2 settlement: Permit2 PermitWitnessTransferFrom.
 *
 * Servers advertise it with `extra.assetTransferMethod: "permit2"`. The client
 * signs two EIP-712 messages sharing one deadline:
 *
 *   1. EIP-2612 Permit — spender is the canonical Permit2 contract, nonce is
 *      sequential from `token.nonces(owner)`. Goes in
 *      `extensions.eip2612GasSponsoring.info.signature` so the facilitator can
 *      establish the Permit2 allowance gas-free on the payer's behalf.
 *   2. Permit2 PermitWitnessTransferFrom — spender is the x402 proxy, nonce is
 *      random, the witness binds the transfer to the merchant's payTo. Goes in
 *      `payload.signature`.
 *
 * Source of truth: radiustechsystems/skills plugins/radius/skills/x402
 * (scripts/x402-pay.mjs, references/permit2-typed-data.template.json).
 */

export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const X402_PERMIT2_PROXY: Address = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

export const PERMIT2_WITNESS_TYPES = {
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
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

export function randomPermit2Nonce(): bigint {
  return BigInt('0x' + randomBytes(16).toString('hex'));
}

export async function signPermit2WitnessTransfer(
  account: LocalAccount,
  args: {
    token: Address;
    chainId: number;
    amount: bigint;
    payTo: Address;
    nonce: bigint;
    deadline: bigint;
  },
): Promise<Hex> {
  return await account.signTypedData({
    domain: {
      name: 'Permit2',
      chainId: args.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: args.token, amount: args.amount },
      spender: X402_PERMIT2_PROXY,
      nonce: args.nonce,
      deadline: args.deadline,
      witness: { to: args.payTo, validAfter: 0n },
    },
  });
}

/** Assemble the full base64 PAYMENT-SIGNATURE payload per the radius x402 skill. */
export function buildPermit2PaymentPayload(args: {
  chainId: number;
  resource: { url: string; description?: string; mimeType?: string };
  accepted: Record<string, unknown>;
  token: Address;
  amount: bigint;
  owner: Address;
  payTo: Address;
  permit2Signature: Hex;
  permit2Nonce: bigint;
  eip2612Signature: Hex;
  eip2612Nonce: bigint;
  deadline: bigint;
}): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: `eip155:${args.chainId}`,
    resource: {
      url: args.resource.url,
      description: args.resource.description ?? '',
      mimeType: args.resource.mimeType ?? 'application/json',
    },
    accepted: args.accepted,
    payload: {
      signature: args.permit2Signature,
      permit2Authorization: {
        permitted: { token: args.token, amount: args.amount.toString() },
        from: args.owner,
        spender: X402_PERMIT2_PROXY,
        nonce: args.permit2Nonce.toString(),
        deadline: args.deadline.toString(),
        witness: { to: args.payTo, validAfter: '0' },
      },
    },
    extensions: {
      eip2612GasSponsoring: {
        info: {
          from: args.owner,
          asset: args.token,
          spender: PERMIT2_ADDRESS,
          amount: args.amount.toString(),
          nonce: args.eip2612Nonce.toString(),
          deadline: args.deadline.toString(),
          signature: args.eip2612Signature,
          version: '1',
        },
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
