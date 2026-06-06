import { keystoreProvider } from './keystore.js';
import { paraProvider } from './para.js';
import { cdpProvider } from './cdp.js';
import { privyProvider } from './privy.js';
import { proxyProvider } from './proxy.js';
import type { WalletProviderName } from '../../types.js';
import type { WalletProvider } from './types.js';

const providers: Record<WalletProviderName, WalletProvider> = {
  keystore: keystoreProvider,
  cdp: cdpProvider,
  para: paraProvider,
  privy: privyProvider,
  proxy: proxyProvider,
};

export function getProvider(name: WalletProviderName): WalletProvider {
  return providers[name];
}
