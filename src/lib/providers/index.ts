import { keystoreProvider } from './keystore.js';
import { paraProvider } from './para.js';
import { cdpProvider } from './cdp.js';
import type { WalletProviderName } from '../../types.js';
import type { WalletProvider } from './types.js';

const providers: Record<WalletProviderName, WalletProvider> = {
  keystore: keystoreProvider,
  cdp: cdpProvider,
  para: paraProvider,
  privy: stubProvider('privy'),
};

function stubProvider(name: string): WalletProvider {
  return {
    async getAccount(): Promise<never> {
      throw new Error(`${name} provider is not yet implemented.`);
    },
    async getAddress(): Promise<never> {
      throw new Error(`${name} provider is not yet implemented.`);
    },
    async login(): Promise<void> {
      throw new Error(`${name} provider is not yet implemented.`);
    },
    async logout(): Promise<void> {
      throw new Error(`${name} provider is not yet implemented.`);
    },
    async status(): Promise<void> {
      throw new Error(`${name} provider is not yet implemented.`);
    },
  };
}

export function getProvider(name: WalletProviderName): WalletProvider {
  return providers[name];
}
