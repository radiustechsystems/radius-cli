import { input, password as promptPassword, select } from '@inquirer/prompts';
import { type Address, type Hex, type LocalAccount } from 'viem';
import { toAccount } from 'viem/accounts';
import { readProviderConfig, writeProviderConfig, deleteProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import { disableProviderTelemetry } from '../providerTelemetry.js';
import { signLegacyTransaction } from './remoteSigning.js';
import { deleteProviderSession, providerSessionPath, readProviderSession, writeProviderSession } from './session.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

const SESSION_FILE = 'cdp-session.json';

interface CdpSession {
  address: string;
  accountName?: string;
}

function readSession(): CdpSession | null {
  return readProviderSession<CdpSession>(SESSION_FILE);
}

function writeSession(session: CdpSession): void {
  writeProviderSession(SESSION_FILE, session);
}

function deleteSession(): void {
  deleteProviderSession(SESSION_FILE);
}

async function loadCdpSDK() {
  disableProviderTelemetry('cdp');
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
  try {
    return await cdp.evm.getAccount({ address: session.address as Address });
  } catch (e) {
    if (!session.accountName) throw e;
    return await cdp.evm.getOrCreateAccount({ name: session.accountName });
  }
}

async function listCdpAccounts(cdp: Awaited<ReturnType<typeof makeCdpClient>>): Promise<CdpSession[]> {
  const accounts: CdpSession[] = [];
  let pageToken: string | undefined;
  do {
    const page = await cdp.evm.listAccounts({ pageSize: 25, pageToken });
    accounts.push(...page.accounts.map((account) => ({
      address: account.address,
      accountName: account.name,
    })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return accounts;
}

async function chooseCdpSession(cdp: Awaited<ReturnType<typeof makeCdpClient>>): Promise<CdpSession> {
  let accounts: CdpSession[] = [];
  try {
    accounts = await listCdpAccounts(cdp);
  } catch {
    // Listing is a convenience. Manual get-or-create still covers the login path.
  }

  if (accounts.length > 0 && process.stdin.isTTY) {
    const choice = await select<{ type: 'existing'; session: CdpSession } | { type: 'new' } | { type: 'manual' }>({
      message: 'CDP account:',
      choices: [
        ...accounts.map((session) => ({
          name: `${session.accountName ?? '(unnamed)'} ${session.address}`,
          value: { type: 'existing' as const, session },
        })),
        { name: 'Create a new account', value: { type: 'new' as const } },
        { name: 'Enter account name manually', value: { type: 'manual' as const } },
      ],
    });

    if (choice.type === 'existing') return choice.session;
    if (choice.type === 'new') {
      const name = (await input({ message: 'New account name (leave empty to auto-generate):' })).trim();
      const accountName = name || `radius-cli-${Date.now()}`;
      const account = await cdp.evm.getOrCreateAccount({ name: accountName });
      return { address: account.address, accountName };
    }
  }

  const userInput = await input({
    message: accounts.length > 0
      ? 'Account name:'
      : 'Account name (leave empty to create new):',
  });

  const accountName = userInput.trim() || `radius-cli-${Date.now()}`;
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  return { address: account.address, accountName };
}

export const cdpProvider: WalletProvider = {
  async login(_cfg: ResolvedConfig, opts?: { reset?: boolean }): Promise<void> {
    if (opts?.reset) {
      deleteSession();
      deleteProviderConfig('cdp');
      console.log('CDP credentials and session cleared.');
    }

    const existing = readSession();
    if (existing) {
      console.log(`Already logged in with CDP (${existing.address})`);
      console.log('Run `radius-cli --wallet cdp wallet logout` first, or use `wallet login --reset` to start over.');
      return;
    }

    const creds = await resolveCredentials({ interactive: true });
    const cdp = await makeCdpClient(creds);
    const session = await chooseCdpSession(cdp);
    writeSession(session);

    console.log(`CDP account ready`);
    console.log(`Address: ${session.address}`);
    if (session.accountName) console.log(`Account: ${session.accountName}`);
    console.log(`Session saved to ${providerSessionPath(SESSION_FILE)}`);
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
        return signLegacyTransaction(tx, async (hash) => {
          const signature = await cdpAccount.sign({ hash });
          return signature as Hex;
        });
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
