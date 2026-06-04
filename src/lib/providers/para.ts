import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { input } from '@inquirer/prompts';
import type { Address, Hex, LocalAccount } from 'viem';
import { radiusDir, readProviderConfig, writeProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

const SESSION_FILE = 'para-session.json';

interface ParaSession {
  email: string;
  userShare: string;
  walletId: string;
  address: string;
}

function sessionPath(): string {
  return join(radiusDir(), SESSION_FILE);
}

function readSession(): ParaSession | null {
  const p = sessionPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ParaSession;
  } catch {
    return null;
  }
}

function writeSession(session: ParaSession): void {
  const dir = radiusDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

function deleteSession(): void {
  const p = sessionPath();
  if (existsSync(p)) unlinkSync(p);
}

async function loadParaSDK() {
  try {
    const { Para, Environment } = await import('@getpara/server-sdk');
    const { createParaViemAccount } = await import('@getpara/viem-v2-integration');
    return { Para, Environment, createParaViemAccount };
  } catch {
    throw new Error(
      'Para SDK packages are not installed. Run:\n' +
      '  npm install @getpara/server-sdk @getpara/viem-v2-integration\n' +
      'to enable the Para wallet provider.',
    );
  }
}

async function resolveApiKey(opts: { interactive?: boolean } = {}): Promise<string> {
  // env var → config → prompt (if interactive) → error
  const key = process.env.PARA_API_KEY ?? readProviderConfig('para').apiKey;
  if (key) return key;

  if (opts.interactive && process.stdin.isTTY) {
    const prompted = await input({
      message: 'Para API key (from https://developer.getpara.com):',
    });
    if (!prompted.trim()) throw new Error('API key is required.');
    writeProviderConfig('para', { apiKey: prompted.trim() });
    console.log('API key saved to ~/.radius/config.json');
    return prompted.trim();
  }

  throw new Error(
    'Para API key not configured. Run `radius-cli --wallet para wallet login` to set it up,\n' +
    'or set the PARA_API_KEY environment variable.\n' +
    'Get your API key from https://developer.getpara.com',
  );
}

function resolveEnvironmentValue(): string {
  return (process.env.PARA_ENV ?? readProviderConfig('para').env ?? 'BETA').toUpperCase();
}

export const paraProvider: WalletProvider = {
  async login(_cfg: ResolvedConfig): Promise<void> {
    const existing = readSession();
    if (existing) {
      console.log(`Already logged in as ${existing.email} (${existing.address})`);
      console.log('Run `radius-cli wallet logout` first to switch accounts.');
      return;
    }

    const sdk = await loadParaSDK();
    const apiKey = await resolveApiKey({ interactive: true });
    const email = await input({ message: 'Para email:' });
    if (!email.trim()) throw new Error('Email is required.');

    const envStr = resolveEnvironmentValue();
    const env = sdk.Environment[envStr as keyof typeof sdk.Environment] ?? sdk.Environment.BETA;
    const para = new sdk.Para(env, apiKey);

    const hasWallet = await para.hasPregenWallet({ pregenId: { email } });

    let walletId: string;
    let address: string;

    if (hasWallet) {
      const wallets = await para.getPregenWallets({ pregenId: { email } });
      const evmWallet = wallets.find((w) => w.type === 'EVM');
      if (!evmWallet) {
        throw new Error('No EVM wallet found for this email. Create one at https://developer.getpara.com');
      }
      walletId = evmWallet.id;
      address = evmWallet.address ?? '';
    } else {
      const wallet = await para.createPregenWallet({
        type: 'EVM',
        pregenId: { email },
      });
      walletId = wallet.id;
      address = wallet.address ?? '';
    }

    if (!address) {
      const wallets = para.getWallets();
      const w = wallets[walletId];
      address = w?.address ?? '';
    }

    // getUserShare() returns string | null in v3; null means no share available.
    const userShare = para.getUserShare();
    if (!userShare) {
      throw new Error('Failed to obtain user share from Para. Please try again.');
    }

    const session: ParaSession = { email, userShare, walletId, address };
    writeSession(session);

    console.log(`Logged in as ${email} (pregenerated wallet — not yet claimed)`);
    console.log(`Address: ${address}`);
    console.log(`Session saved to ${sessionPath()}`);
  },

  async logout(_cfg: ResolvedConfig): Promise<void> {
    const session = readSession();
    if (!session) {
      console.log('Not logged in to Para.');
      return;
    }
    deleteSession();
    console.log(`Logged out of Para (${session.email}).`);
  },

  async status(_cfg: ResolvedConfig, opts: GlobalOptions): Promise<void> {
    const session = readSession();
    if (opts.json) {
      console.log(jsonStringify({
        provider: 'para',
        loggedIn: !!session,
        email: session?.email ?? null,
        address: session?.address ?? null,
      }));
      return;
    }
    console.log('Provider: para');
    if (session) {
      console.log(`Email:    ${session.email}`);
      console.log(`Address:  ${session.address}`);
    } else {
      console.log('Status:   not logged in');
      console.log('Run `radius-cli wallet login` to authenticate with Para.');
    }
  },

  async getAccount(_cfg: ResolvedConfig): Promise<LocalAccount> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to Para. Run `radius-cli wallet login` first.',
      );
    }

    const sdk = await loadParaSDK();
    const apiKey = await resolveApiKey();
    const envStr = resolveEnvironmentValue();
    const env = sdk.Environment[envStr as keyof typeof sdk.Environment] ?? sdk.Environment.BETA;
    const para = new sdk.Para(env, apiKey);
    await para.setUserShare(session.userShare);

    // Pass session address to ensure we sign as the wallet that login printed.
    // Cast needed: server SDK's Para extends ParaCore but has a slightly
    // different claimPregenWallets return type. Functionally identical for signing.
    return sdk.createParaViemAccount({ para: para as any, address: session.address as Hex });
  },

  async getAddress(_cfg: ResolvedConfig): Promise<Address> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to Para. Run `radius-cli wallet login` first.',
      );
    }
    return session.address as Address;
  },

  // Para uses MPC — no single private key exists. Export is not possible.
  // Omitting exportPrivateKey makes wallet.ts throw the appropriate error.
};
