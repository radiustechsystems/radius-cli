import type { Address, Chain, PublicClient, WalletClient } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export type WalletProviderName = 'keystore' | 'cdp' | 'para' | 'privy' | 'proxy';

export interface ResolvedConfig {
  network: NetworkName;
  chain: Chain;
  rpcUrl: string;
  sbcAddress?: Address;
  rusdAddress?: Address;
  keystorePath: string;
  password?: string;
  walletProvider: WalletProviderName;
}

export interface GlobalOptions {
  network?: string;
  rpcUrl?: string;
  privateKey?: string;
  sbc?: string;
  rusd?: string;
  json?: boolean;
  wait?: boolean;
  wallet?: string;
}

export type { WalletProvider } from './lib/providers/types.js';

export interface Clients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}
