import { password as promptPassword } from '@inquirer/prompts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex, PrivateKeyAccount } from 'viem';
import { keystoreExists, loadAccount, readKeystoreAddress, saveKeystore } from './keystore.js';
import { readPasswordless, writeCachedAddress, writePasswordless } from './config.js';
import type { ResolvedConfig } from '../types.js';

function normalizePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('--private-key must be a 32-byte hex string (64 hex chars, optional 0x prefix).');
  }
  return withPrefix as Hex;
}

async function resolvePassword(cfg: ResolvedConfig): Promise<string> {
  if (cfg.password !== undefined) return cfg.password;
  if (readPasswordless()) return '';
  return await promptPassword({ message: 'Keystore password:', mask: '*' });
}

/**
 * Generate a fresh keystore on first use. Uses RADIUS_PASSWORD if set, empty otherwise.
 * An empty password means the keystore JSON is effectively unencrypted — the file mode
 * (0o600) is the only protection. The notice on stderr makes that clear.
 */
async function autoCreateKeystore(cfg: ResolvedConfig): Promise<PrivateKeyAccount> {
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

/** Returns a viem account. Auto-creates a keystore on first use; prompts for password if one exists. */
export async function requireAccount(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<PrivateKeyAccount> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt));
  }
  if (!keystoreExists(cfg.keystorePath)) {
    return await autoCreateKeystore(cfg);
  }
  const password = await resolvePassword(cfg);
  return await loadAccount(cfg.keystorePath, password);
}

/** Returns just the local address — no password prompt. Auto-creates a keystore on first use. */
export async function getOwnAddress(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<`0x${string}`> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt)).address;
  }
  const addr = readKeystoreAddress(cfg.keystorePath);
  if (addr) return addr;
  return (await autoCreateKeystore(cfg)).address;
}
