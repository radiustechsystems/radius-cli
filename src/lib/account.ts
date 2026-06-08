import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, LocalAccount } from 'viem';
import { getProvider } from './providers/index.js';
import type { ResolvedConfig } from '../types.js';

function normalizePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('--private-key must be a 32-byte hex string (64 hex chars, optional 0x prefix).');
  }
  return withPrefix as Hex;
}

/** Returns a viem account via the active provider. --private-key overrides any provider. */
export async function requireAccount(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<LocalAccount> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt));
  }
  const provider = getProvider(cfg.walletProvider);
  return await provider.getAccount(cfg);
}

/** Returns just the address via the active provider — no password prompt for keystore. */
export async function getOwnAddress(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<Address> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt)).address;
  }
  const provider = getProvider(cfg.walletProvider);
  return await provider.getAddress(cfg);
}
