import { password as promptPassword } from '@inquirer/prompts';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, PrivateKeyAccount } from 'viem';
import { keystoreExists, loadAccount, readKeystoreAddress } from './keystore.js';
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
  return await promptPassword({ message: 'Keystore password:', mask: '*' });
}

/** Returns a viem account, prompting for password if needed. Throws if no signer is available. */
export async function requireAccount(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<PrivateKeyAccount> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt));
  }
  if (!keystoreExists(cfg.keystorePath)) {
    throw new Error(
      `No keystore found at ${cfg.keystorePath}. Run \`radius-cli wallet new\`, \`radius-cli wallet import\`, or pass --private-key.`,
    );
  }
  const password = await resolvePassword(cfg);
  return await loadAccount(cfg.keystorePath, password);
}

/** Like requireAccount but only returns the address — no password prompt if a cached/keystore address is on disk. */
export async function getOwnAddress(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<`0x${string}`> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt)).address;
  }
  const addr = readKeystoreAddress(cfg.keystorePath);
  if (addr) return addr;
  throw new Error(
    `No keystore found at ${cfg.keystorePath}. Run \`radius-cli wallet new\` or pass --private-key.`,
  );
}
