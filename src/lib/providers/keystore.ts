import { readKeystoreAddress } from '../keystore.js';
import { jsonStringify } from '../format.js';
import type { ResolvedConfig, GlobalOptions, WalletProviderInterface } from '../../types.js';

export const keystoreProvider: WalletProviderInterface = {
  async login(_cfg: ResolvedConfig): Promise<void> {
    console.log(
      'Keystore wallets do not require login.\n' +
      'To create a new wallet: radius-cli wallet new\n' +
      'To import an existing key: radius-cli wallet import <privateKey>',
    );
  },

  async logout(_cfg: ResolvedConfig): Promise<void> {
    // Keystore logout is a no-op.
  },

  async status(cfg: ResolvedConfig, opts: GlobalOptions): Promise<void> {
    const address = readKeystoreAddress(cfg.keystorePath);
    if (opts.json) {
      console.log(jsonStringify({ provider: 'keystore', address: address ?? null }));
      return;
    }
    console.log(`Provider: keystore`);
    if (address) {
      console.log(`Address:  ${address}`);
    } else {
      console.log('No keystore found. Run `radius-cli wallet new` to create one.');
    }
  },
};
