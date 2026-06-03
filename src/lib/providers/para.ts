import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { input } from '@inquirer/prompts';
import type { Address, LocalAccount } from 'viem';
import { Para as ParaServer, Environment } from '@getpara/server-sdk';
import { createParaViemAccount } from '@getpara/viem-v2-integration';
import { radiusDir, readParaApiKey, writeParaApiKey } from '../config.js';
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

function resolveApiKey(): string {
  const key = process.env.PARA_API_KEY ?? readParaApiKey();
  if (!key) {
    throw new Error(
      'Para API key not configured. Run `radius-cli --wallet para wallet login` to set it up,\n' +
      'or set the PARA_API_KEY environment variable.\n' +
      'Get your API key from https://developer.getpara.com',
    );
  }
  return key;
}

async function resolveApiKeyInteractive(): Promise<string> {
  // env var takes priority
  const envKey = process.env.PARA_API_KEY;
  if (envKey) return envKey;

  // check config
  const savedKey = readParaApiKey();
  if (savedKey) return savedKey;

  // prompt and save
  const key = await input({
    message: 'Para API key (from https://developer.getpara.com):',
  });
  if (!key.trim()) throw new Error('API key is required.');
  writeParaApiKey(key.trim());
  console.log('API key saved to ~/.radius/config.json');
  return key.trim();
}

function resolveEnvironment(): Environment {
  const env = process.env.PARA_ENV?.toUpperCase();
  if (env === 'PROD') return Environment.PROD;
  if (env === 'DEV') return Environment.DEV;
  if (env === 'SANDBOX') return Environment.SANDBOX;
  return Environment.BETA;
}

function makePara(): ParaServer {
  return new ParaServer(resolveEnvironment(), resolveApiKey());
}

async function ensureParaReady(para: ParaServer, session: ParaSession): Promise<void> {
  await para.setUserShare(session.userShare);
}

export const paraProvider: WalletProvider = {
  async login(_cfg: ResolvedConfig): Promise<void> {
    const existing = readSession();
    if (existing) {
      console.log(`Already logged in as ${existing.email} (${existing.address})`);
      console.log('Run `radius-cli wallet logout` first to switch accounts.');
      return;
    }

    const apiKey = await resolveApiKeyInteractive();
    const email = await input({ message: 'Para email:' });
    if (!email.trim()) throw new Error('Email is required.');

    const para = new ParaServer(resolveEnvironment(), apiKey);

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

    const userShare = para.getUserShare();
    if (!userShare) {
      throw new Error('Failed to obtain user share from Para. Please try again.');
    }

    const session: ParaSession = { email, userShare, walletId, address };
    writeSession(session);

    console.log(`Logged in as ${email}`);
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

    const para = makePara();
    await ensureParaReady(para, session);

    // Try with address first, fall back to default (first EVM wallet)
    const wallets = para.getWallets();
    const walletIds = Object.keys(wallets);
    if (walletIds.length === 0) {
      throw new Error(
        'No wallets found in Para session. Try `radius-cli --wallet para wallet logout` then `wallet login` again.',
      );
    }

    // Use positional overload; omit address to let Para pick the first EVM wallet
    return createParaViemAccount(para as any);
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
