import type { Address, Chain, PublicClient, WalletClient } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export type WalletProviderName = 'keystore' | 'cdp' | 'para' | 'privy';

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

export interface WalletProviderInterface {
  login?(cfg: ResolvedConfig): Promise<void>;
  logout?(cfg: ResolvedConfig): Promise<void>;
  status(cfg: ResolvedConfig, opts: GlobalOptions): Promise<void>;
}

export interface Clients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}
