import { randomBytes } from 'node:crypto';
import type { Address, Hex, PrivateKeyAccount, PublicClient } from 'viem';
import type { Authorization } from './protocol.js';

export const ERC20_X402_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface AssetInfo {
  decimals: number;
  symbol: string | null;
  name: string;
  version: string;
}

export async function readAssetInfo(
  client: PublicClient,
  asset: Address,
  extra: { name?: string; version?: string } | undefined,
): Promise<AssetInfo> {
  const decimals = (await client.readContract({
    address: asset,
    abi: ERC20_X402_ABI,
    functionName: 'decimals',
  })) as number;

  let symbol: string | null = null;
  try {
    symbol = (await client.readContract({
      address: asset,
      abi: ERC20_X402_ABI,
      functionName: 'symbol',
    })) as string;
  } catch {
    symbol = null;
  }

  let name = extra?.name;
  if (!name) {
    name = (await client.readContract({
      address: asset,
      abi: ERC20_X402_ABI,
      functionName: 'name',
    })) as string;
  }

  let version = extra?.version;
  if (!version) {
    try {
      version = (await client.readContract({
        address: asset,
        abi: ERC20_X402_ABI,
        functionName: 'version',
      })) as string;
    } catch {
      version = '1';
    }
  }

  return { decimals, symbol, name, version };
}

export async function readBalance(
  client: PublicClient,
  asset: Address,
  owner: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: asset,
    abi: ERC20_X402_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

export function randomNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

export function makeAuthorization(args: {
  from: Address;
  to: Address;
  value: bigint;
  maxTimeoutSeconds: number | undefined;
}): Authorization {
  const window = Math.min(Math.max(args.maxTimeoutSeconds ?? 600, 1), 600);
  const validBefore = Math.floor(Date.now() / 1000) + window;
  return {
    from: args.from,
    to: args.to,
    value: args.value,
    validAfter: 0,
    validBefore,
    nonce: randomNonce(),
  };
}

export async function signTransferAuthorization(
  account: PrivateKeyAccount,
  args: {
    asset: Address;
    chainId: number;
    name: string;
    version: string;
    authorization: Authorization;
  },
): Promise<Hex> {
  return await account.signTypedData({
    domain: {
      name: args.name,
      version: args.version,
      chainId: args.chainId,
      verifyingContract: args.asset,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: args.authorization.from,
      to: args.authorization.to,
      value: args.authorization.value,
      validAfter: BigInt(args.authorization.validAfter),
      validBefore: BigInt(args.authorization.validBefore),
      nonce: args.authorization.nonce,
    },
  });
}

export { EIP3009_TYPES };
