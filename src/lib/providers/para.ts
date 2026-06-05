import { input, confirm } from '@inquirer/prompts';
import type { Address, Hex, LocalAccount } from 'viem';
import { readProviderConfig, writeProviderConfig, deleteProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import { disableProviderTelemetry } from '../providerTelemetry.js';
import {
  moveProviderSession,
  providerSessionPath,
  readProviderSession,
  readProviderSessionFile,
  writeProviderSession,
} from './session.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

const SESSION_FILE = 'para-session.json';
const BACKUP_SESSION_FILE = 'para-session.bak.json';
const PARA_SERVER_OPTS = { disableWorkers: true, disableWebSockets: true } as const;

interface ParaSession {
  email: string;
  userShare: string;
  walletId: string;
  address: string;
}

function sessionPath(): string {
  return providerSessionPath(SESSION_FILE);
}

function readSessionFile(p: string): ParaSession | null {
  return readProviderSessionFile<ParaSession>(p);
}

function readSession(): ParaSession | null {
  return readProviderSession<ParaSession>(SESSION_FILE);
}

function writeSession(session: ParaSession): void {
  writeProviderSession(SESSION_FILE, session);
}

function backupSessionPath(): string {
  return providerSessionPath(BACKUP_SESSION_FILE);
}

function archiveSession(): string | null {
  return moveProviderSession(SESSION_FILE, BACKUP_SESSION_FILE);
}

async function restoreArchivedSession(): Promise<boolean> {
  const backupPath = backupSessionPath();
  const archived = readSessionFile(backupPath);
  if (!archived) return false;

  const shouldRestore = process.stdin.isTTY
    ? await confirm({
      message: `Restore archived Para session for ${archived.email} (${archived.address})?`,
      default: true,
    })
    : true;

  if (!shouldRestore) return false;

  if (!moveProviderSession(BACKUP_SESSION_FILE, SESSION_FILE)) return false;
  console.log(`Restored Para session from ${backupPath}.`);
  console.log(`Address: ${archived.address}`);
  return true;
}

function normalizeParaError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    const msg = typeof obj['message'] === 'string' ? obj['message'] : JSON.stringify(e, null, 2);
    return new Error(`Para SDK error: ${msg}`);
  }
  return new Error(`Para SDK error: ${String(e)}`);
}

async function loadParaSDK() {
  disableProviderTelemetry('para');
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
  async login(_cfg: ResolvedConfig, opts?: { reset?: boolean }): Promise<void> {
    if (opts?.reset) {
      const backupPath = archiveSession();
      deleteProviderConfig('para');
      console.log('Para credentials and session cleared.');
      if (backupPath) console.log(`Previous Para session archived to ${backupPath}.`);
    }

    const existing = readSession();
    if (existing) {
      console.log(`Already logged in as ${existing.email} (${existing.address})`);
      console.log('Run `radius-cli --wallet para wallet logout` first, or use `wallet login --reset` to start over.');
      return;
    }

    if (!opts?.reset && await restoreArchivedSession()) {
      return;
    }

    const sdk = await loadParaSDK();
    const apiKey = await resolveApiKey({ interactive: true });
    const email = await input({ message: 'Para email:' });
    if (!email.trim()) throw new Error('Email is required.');

    const envStr = resolveEnvironmentValue();
    const env = sdk.Environment[envStr as keyof typeof sdk.Environment] ?? sdk.Environment.BETA;

    let para: InstanceType<typeof sdk.Para>;
    try {
      para = new sdk.Para(env, apiKey, PARA_SERVER_OPTS);
    } catch (e) {
      throw normalizeParaError(e);
    }

    let hasWallet: boolean;
    try {
      hasWallet = await para.hasPregenWallet({ pregenId: { email } });
    } catch (e) {
      throw normalizeParaError(e);
    }

    let walletId: string;
    let address: string;

    if (hasWallet) {
      let wallets: Awaited<ReturnType<typeof para.getPregenWallets>>;
      try {
        wallets = await para.getPregenWallets({ pregenId: { email } });
      } catch (e) {
        throw normalizeParaError(e);
      }
      const evmWallet = wallets.find((w) => w.type === 'EVM');
      if (!evmWallet) {
        throw new Error('No EVM wallet found for this email. Create one at https://developer.getpara.com');
      }
      walletId = evmWallet.id;
      address = evmWallet.address ?? '';
    } else {
      let wallet: Awaited<ReturnType<typeof para.createPregenWallet>>;
      try {
        wallet = await para.createPregenWallet({
          type: 'EVM',
          pregenId: { email },
        });
      } catch (e) {
        throw normalizeParaError(e);
      }
      walletId = wallet.id;
      address = wallet.address ?? '';
    }

    if (!address) {
      const wallets = para.getWallets();
      const w = wallets[walletId];
      address = w?.address ?? '';
    }

    // getUserShare() returns the in-memory MPC signer encoded as base64.
    // It is only populated right after createPregenWallet() — getPregenWallets()
    // returns wallet metadata only; Para's servers never hold the user share.
    const userShare = para.getUserShare();
    if (!userShare) {
      const backupPath = backupSessionPath();
      const hint = readSessionFile(backupPath)
        ? `A previous session backup exists at ${backupPath}.\n` +
          'Run `radius-cli --wallet para wallet login` and choose restore.'
        : 'No session backup found. The signing key for this address cannot be recovered.';
      throw new Error(
        `Para wallet ${address} exists but the signing key is not available.\n\n` +
        'Para\'s MPC signing key (user share) is generated once at wallet creation and\n' +
        'is never stored by Para\'s servers. If you ran `wallet logout`, the key was\n' +
        'archived or deleted from this machine.\n\n' +
        hint + '\n\n' +
        'To use a new wallet, register with a different email address.',
      );
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

    console.log(`Address: ${session.address}`);
    console.log(`\nThis signs out by archiving the local Para session.`);
    console.log('The signing key is preserved and can be restored with `radius-cli --wallet para wallet login`.');
    console.log(`The session will be archived to ${backupSessionPath()}.\n`);

    const ok = process.stdin.isTTY
      ? await confirm({ message: 'Continue with logout?', default: false })
      : true;

    if (!ok) {
      console.log('Logout cancelled.');
      return;
    }

    const backupPath = archiveSession();
    console.log(`Logged out of Para (${session.email}).`);
    if (backupPath) console.log(`Session archived to ${backupPath}.`);
    console.log('Run `radius-cli --wallet para wallet login` to restore it later.');
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
      console.log('Run `radius-cli --wallet para wallet login` to authenticate with Para.');
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
    const para = new sdk.Para(env, apiKey, PARA_SERVER_OPTS);
    await para.setUserShare(session.userShare);
    await para.setCurrentWalletIds({ EVM: [session.walletId] });

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
