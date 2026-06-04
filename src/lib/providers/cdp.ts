import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { input, password as promptPassword } from '@inquirer/prompts';
import { type Address, type Hex, type LocalAccount, type TransactionSerializable, keccak256, serializeTransaction } from 'viem';
import { toAccount } from 'viem/accounts';
import { radiusDir, readProviderConfig, writeProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

const SESSION_FILE = 'cdp-session.json';

interface CdpSession {
  address: string;
  accountName?: string;
}

function sessionPath(): string {
  return join(radiusDir(), SESSION_FILE);
}

function readSession(): CdpSession | null {
  const p = sessionPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CdpSession;
  } catch {
    return null;
  }
}

function writeSession(session: CdpSession): void {
  const dir = radiusDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

function deleteSession(): void {
  const p = sessionPath();
  if (existsSync(p)) unlinkSync(p);
}

async function loadCdpSDK() {
  try {
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    return { CdpClient };
  } catch {
    throw new Error(
      'CDP SDK package is not installed. Run:\n' +
      '  npm install @coinbase/cdp-sdk\n' +
      'to enable the CDP wallet provider.',
    );
  }
}

interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

async function resolveCredentials(opts: { interactive?: boolean } = {}): Promise<CdpCredentials> {
  // env → config → prompt (if interactive) → error
  const config = readProviderConfig('cdp');
  const apiKeyId = process.env.CDP_API_KEY_ID ?? config.apiKeyId;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET ?? config.apiKeySecret;
  const walletSecret = process.env.CDP_WALLET_SECRET ?? config.walletSecret;

  if (apiKeyId && apiKeySecret && walletSecret) {
    return { apiKeyId, apiKeySecret, walletSecret };
  }

  if (opts.interactive && process.stdin.isTTY) {
    const prompted: CdpCredentials = {
      apiKeyId: apiKeyId ?? await input({ message: 'CDP API Key ID:' }),
      apiKeySecret: apiKeySecret ?? await promptPassword({ message: 'CDP API Key Secret:', mask: '*' }),
      walletSecret: walletSecret ?? await promptPassword({ message: 'CDP Wallet Secret:', mask: '*' }),
    };
    if (!prompted.apiKeyId.trim() || !prompted.apiKeySecret.trim() || !prompted.walletSecret.trim()) {
      throw new Error('All three CDP credentials are required.');
    }
    writeProviderConfig('cdp', {
      apiKeyId: prompted.apiKeyId.trim(),
      apiKeySecret: prompted.apiKeySecret.trim(),
      walletSecret: prompted.walletSecret.trim(),
    });
    console.log('CDP credentials saved to ~/.radius/config.json');
    return prompted;
  }

  const missing = [
    !apiKeyId && 'CDP_API_KEY_ID',
    !apiKeySecret && 'CDP_API_KEY_SECRET',
    !walletSecret && 'CDP_WALLET_SECRET',
  ].filter(Boolean);

  throw new Error(
    `CDP credentials not configured (missing: ${missing.join(', ')}).\n` +
    'Run `radius-cli --wallet cdp wallet login` to set them up,\n' +
    'or set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET environment variables.\n' +
    'Get credentials from https://portal.cdp.coinbase.com',
  );
}

async function makeCdpClient(creds: CdpCredentials) {
  const { CdpClient } = await loadCdpSDK();
  return new CdpClient({
    apiKeyId: creds.apiKeyId,
    apiKeySecret: creds.apiKeySecret,
    walletSecret: creds.walletSecret,
  });
}

async function getOrCreateCdpAccount(creds: CdpCredentials, session: CdpSession) {
  const cdp = await makeCdpClient(creds);
  if (!session.accountName) {
    throw new Error(
      'CDP session is missing account name. Run `radius-cli --wallet cdp wallet logout` then `wallet login` again.',
    );
  }
  return await cdp.evm.getOrCreateAccount({ name: session.accountName });
}

export const cdpProvider: WalletProvider = {
  async login(_cfg: ResolvedConfig): Promise<void> {
    const existing = readSession();
    if (existing) {
      console.log(`Already logged in with CDP (${existing.address})`);
      console.log('Run `radius-cli wallet logout` first to switch accounts.');
      return;
    }

    const creds = await resolveCredentials({ interactive: true });
    const cdp = await makeCdpClient(creds);

    const userInput = await input({
      message: 'Account name (leave empty to create new):',
    });

    // Always use a name — auto-generate one if the user leaves it blank.
    // CDP accounts are primarily keyed by name; address-only lookup is fragile.
    const accountName = userInput.trim() || `radius-cli-${Date.now()}`;
    const account = await cdp.evm.getOrCreateAccount({ name: accountName });

    const session: CdpSession = {
      address: account.address,
      accountName,
    };
    writeSession(session);

    console.log(`CDP account ready`);
    console.log(`Address: ${account.address}`);
    console.log(`Session saved to ${sessionPath()}`);
  },

  async logout(_cfg: ResolvedConfig): Promise<void> {
    const session = readSession();
    if (!session) {
      console.log('Not logged in to CDP.');
      return;
    }
    deleteSession();
    console.log(`Logged out of CDP (${session.address}).`);
  },

  async status(_cfg: ResolvedConfig, opts: GlobalOptions): Promise<void> {
    const session = readSession();
    if (opts.json) {
      console.log(jsonStringify({
        provider: 'cdp',
        loggedIn: !!session,
        address: session?.address ?? null,
        accountName: session?.accountName ?? null,
      }));
      return;
    }
    console.log('Provider: cdp');
    if (session) {
      console.log(`Address:  ${session.address}`);
      if (session.accountName) console.log(`Account:  ${session.accountName}`);
    } else {
      console.log('Status:   not logged in');
      console.log('Run `radius-cli --wallet cdp wallet login` to set up CDP.');
    }
  },

  async getAccount(_cfg: ResolvedConfig): Promise<LocalAccount> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to CDP. Run `radius-cli wallet login` first.',
      );
    }

    const creds = await resolveCredentials();
    const cdpAccount = await getOrCreateCdpAccount(creds, session);

    // Wrap CDP account with toAccount() so viem recognizes it as type: "local".
    // CDP's EvmServerAccount has type: "evm-server" which viem rejects.
    // Delegate all signing to CDP's MPC infrastructure; the signed tx
    // is then broadcast through the configured Radius RPC by viem's walletClient.
    return toAccount({
      address: session.address as Address,
      async sign({ hash }) {
        return await cdpAccount.sign({ hash }) as Hex;
      },
      async signMessage({ message }) {
        return await cdpAccount.signMessage({ message }) as Hex;
      },
      async signTransaction(tx) {
        // CDP's signTransaction doesn't support legacy transactions (Radius uses legacy).
        // Workaround: serialize the unsigned tx, hash it, sign the hash via CDP,
        // then append the signature to produce the signed transaction.
        const serialized = serializeTransaction(tx as TransactionSerializable);
        const hash = keccak256(serialized);
        const sig = await cdpAccount.sign({ hash });
        // Parse v, r, s from the 65-byte signature
        const r = ('0x' + sig.slice(2, 66)) as Hex;
        const s = ('0x' + sig.slice(66, 130)) as Hex;
        const v = BigInt('0x' + sig.slice(130, 132));
        return serializeTransaction(tx as TransactionSerializable, { r, s, v }) as Hex;
      },
      async signTypedData(typedData) {
        return await cdpAccount.signTypedData(typedData) as Hex;
      },
    });
  },

  async getAddress(_cfg: ResolvedConfig): Promise<Address> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to CDP. Run `radius-cli wallet login` first.',
      );
    }
    return session.address as Address;
  },

  // CDP manages keys server-side — no exportable private key via CLI.
  // Omitting exportPrivateKey makes wallet.ts throw the appropriate error.
};
