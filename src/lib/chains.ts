import { defineChain, type Address, type Chain } from 'viem';

const RUSD = { name: 'Radius USD', symbol: 'RUSD', decimals: 18 } as const;

// SBC is deployed deterministically (same address on mainnet and testnet).
// Source: https://docs.radiustech.xyz/developer-resources/contract-addresses
export const DEFAULT_SBC_ADDRESS: Address = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb';

export const radiusMainnet: Chain = defineChain({
  id: 723487,
  name: 'Radius',
  nativeCurrency: RUSD,
  rpcUrls: {
    default: { http: ['https://rpc.radiustech.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Radius Dashboard', url: 'https://network.radiustech.xyz' },
  },
});

export const radiusTestnet: Chain = defineChain({
  id: 72344,
  name: 'Radius Testnet',
  nativeCurrency: RUSD,
  rpcUrls: {
    default: { http: ['https://rpc.testnet.radiustech.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Radius Dashboard', url: 'https://network.radiustech.xyz' },
  },
  testnet: true,
});

export function chainFor(network: 'mainnet' | 'testnet'): Chain {
  return network === 'testnet' ? radiusTestnet : radiusMainnet;
}
