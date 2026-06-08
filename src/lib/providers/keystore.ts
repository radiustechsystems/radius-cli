import { password as promptPassword } from '@inquirer/prompts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, LocalAccount } from 'viem';
import { keystoreExists, loadAccount, loadKeystorePrivateKey, readKeystoreAddress, saveKeystore } from '../keystore.js';
import { readPasswordless, writeCachedAddress, writePasswordless } from '../config.js';
import { jsonStringify } from '../format.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

async function resolvePassword(cfg: ResolvedConfig): Promise<string> {
  if (cfg.password !== undefined) return cfg.password;
  if (readPasswordless()) return '';
  return await promptPassword({ message: 'Keystore password:', mask: '*' });
}

async function autoCreateKeystore(cfg: ResolvedConfig): Promise<LocalAccount> {
  const pk = generatePrivateKey();
  const password = cfg.password ?? '';
  const address = await saveKeystore(cfg.keystorePath, pk, password);
  writeCachedAddress(address);
  writePasswordless(password === '');

  const lines = [
    `Created new keystore at ${cfg.keystorePath}`,
    `Address: ${address}`,
  ];
  if (password === '') {
    lines.push(
      'No password set — keystore is effectively unencrypted (file mode 0o600).',
      'To rotate to a password-protected keystore: `radius-cli wallet new --force`',
    );
  }
  process.stderr.write(lines.join('\n') + '\n');

  return privateKeyToAccount(pk);
}

export const keystoreProvider: WalletProvider = {
  async getAccount(cfg: ResolvedConfig): Promise<LocalAccount> {
    if (!keystoreExists(cfg.keystorePath)) {
      return await autoCreateKeystore(cfg);
    }
    const password = await resolvePassword(cfg);
    return await loadAccount(cfg.keystorePath, password);
  },

  async getAddress(cfg: ResolvedConfig): Promise<Address> {
    const addr = readKeystoreAddress(cfg.keystorePath);
    if (addr) return addr;
    return (await autoCreateKeystore(cfg)).address;
  },

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

  async exportPrivateKey(cfg: ResolvedConfig): Promise<Hex> {
    const password = cfg.password
      ?? (readPasswordless() ? '' : await promptPassword({ message: 'Keystore password:', mask: '*' }));
    return await loadKeystorePrivateKey(cfg.keystorePath, password);
  },
};
