import { keystoreProvider } from './keystore.js';
import type { WalletProviderName, WalletProviderInterface } from '../../types.js';

const providers: Record<WalletProviderName, WalletProviderInterface> = {
  keystore: keystoreProvider,
  cdp: stubProvider('cdp'),
  para: stubProvider('para'),
  privy: stubProvider('privy'),
};

function stubProvider(name: string): WalletProviderInterface {
  return {
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

export function getProvider(name: WalletProviderName): WalletProviderInterface {
  return providers[name];
}
