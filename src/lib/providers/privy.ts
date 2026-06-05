import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { input, password as promptPassword } from '@inquirer/prompts';
import {
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerializable,
  keccak256,
  serializeTransaction,
  toHex,
} from 'viem';
import { toAccount } from 'viem/accounts';
import { radiusDir, readProviderConfig, writeProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

const PRIVY_API_BASE = 'https://api.privy.io/v1';
const SESSION_FILE = 'privy-session.json';

interface PrivySession {
  walletId: string;
  address: string;
}

interface PrivyCredentials {
  appId: string;
  appSecret: string;
}

function sessionPath(): string {
  return join(radiusDir(), SESSION_FILE);
}

function readSession(): PrivySession | null {
  const p = sessionPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PrivySession;
  } catch {
    return null;
  }
}

function writeSession(session: PrivySession): void {
  const dir = radiusDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

function deleteSession(): void {
  const p = sessionPath();
  if (existsSync(p)) unlinkSync(p);
}

async function resolveCredentials(opts: { interactive?: boolean } = {}): Promise<PrivyCredentials> {
  const config = readProviderConfig('privy');
  const appId = process.env.PRIVY_APP_ID ?? config.appId;
  const appSecret = process.env.PRIVY_APP_SECRET ?? config.appSecret;

  if (appId && appSecret) return { appId, appSecret };

  if (opts.interactive && process.stdin.isTTY) {
    const prompted: PrivyCredentials = {
      appId: appId ?? await input({ message: 'Privy App ID:' }),
      appSecret: appSecret ?? await promptPassword({ message: 'Privy App Secret:', mask: '*' }),
    };
    if (!prompted.appId.trim() || !prompted.appSecret.trim()) {
      throw new Error('Both Privy App ID and App Secret are required.');
    }
    writeProviderConfig('privy', {
      appId: prompted.appId.trim(),
      appSecret: prompted.appSecret.trim(),
    });
    console.log('Privy credentials saved to ~/.radius/config.json');
    return prompted;
  }

  const missing = [
    !appId && 'PRIVY_APP_ID',
    !appSecret && 'PRIVY_APP_SECRET',
  ].filter(Boolean);

  throw new Error(
    `Privy credentials not configured (missing: ${missing.join(', ')}).\n` +
    'Run `radius-cli --wallet privy wallet login` to set them up,\n' +
    'or set PRIVY_APP_ID and PRIVY_APP_SECRET environment variables.\n' +
    'Get credentials from https://dashboard.privy.io',
  );
}

function authHeaders(creds: PrivyCredentials): Record<string, string> {
  const basic = Buffer.from(`${creds.appId}:${creds.appSecret}`).toString('base64');
  return {
    'authorization': `Basic ${basic}`,
    'privy-app-id': creds.appId,
    'content-type': 'application/json',
  };
}

async function privyRpc(
  creds: PrivyCredentials,
  walletId: string,
  method: string,
  params: Record<string, unknown>,
  caip2?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { method, params };
  if (caip2) body.caip2 = caip2;

  const res = await fetch(`${PRIVY_API_BASE}/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const err = JSON.parse(text) as { error?: { message?: string } };
      detail = err.error?.message ?? text;
    } catch {
      detail = text;
    }
    throw new Error(`Privy RPC ${method} failed (${res.status}): ${detail}`);
  }

  const json = await res.json() as { data?: unknown; method?: string };
  return json.data;
}

function buildPrivyAccount(session: PrivySession, creds: PrivyCredentials): LocalAccount {
  return toAccount({
    address: session.address as Address,

    async sign({ hash }) {
      const data = await privyRpc(creds, session.walletId, 'secp256k1_sign', {
        hash,
      });
      return (data as { signature: string }).signature as Hex;
    },

    async signMessage({ message }) {
      let hexMessage: string;
      if (typeof message === 'string') {
        hexMessage = toHex(new TextEncoder().encode(message));
      } else if (message.raw instanceof Uint8Array) {
        hexMessage = toHex(message.raw);
      } else {
        hexMessage = message.raw;
      }

      const data = await privyRpc(creds, session.walletId, 'personal_sign', {
        message: hexMessage,
        encoding: 'hex',
      });
      return (data as { signature: string }).signature as Hex;
    },

    async signTransaction(tx) {
      // Same approach as CDP: serialize unsigned tx, hash, sign hash, reassemble.
      // Radius uses legacy transactions.
      const serialized = serializeTransaction(tx as TransactionSerializable);
      const hash = keccak256(serialized);
      const data = await privyRpc(creds, session.walletId, 'secp256k1_sign', {
        hash,
      });
      const sig = (data as { signature: string }).signature as Hex;
      const r = ('0x' + sig.slice(2, 66)) as Hex;
      const s = ('0x' + sig.slice(66, 130)) as Hex;
      const v = BigInt('0x' + sig.slice(130, 132));
      return serializeTransaction(tx as TransactionSerializable, { r, s, v }) as Hex;
    },

    async signTypedData(typedData) {
      const data = await privyRpc(creds, session.walletId, 'eth_signTypedData_v4', {
        typed_data: {
          domain: typedData.domain,
          types: typedData.types,
          primary_type: typedData.primaryType,
          message: typedData.message,
        },
      });
      return (data as { signature: string }).signature as Hex;
    },
  });
}

export const privyProvider: WalletProvider = {
  async login(_cfg: ResolvedConfig, _opts?: { reset?: boolean }): Promise<void> {
    const existing = readSession();
    if (existing) {
      console.log(`Already logged in with Privy (${existing.address})`);
      console.log('Run `radius-cli wallet logout` first to switch wallets.');
      return;
    }

    const creds = await resolveCredentials({ interactive: true });

    const walletId = await input({
      message: 'Privy wallet ID (leave empty to create new):',
    });

    let session: PrivySession;

    if (walletId.trim()) {
      // Fetch existing wallet
      const res = await fetch(`${PRIVY_API_BASE}/wallets/${walletId.trim()}`, {
        method: 'GET',
        headers: authHeaders(creds),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to fetch wallet ${walletId.trim()}: ${res.status} ${text}`);
      }
      const wallet = await res.json() as { id: string; address: string };
      session = { walletId: wallet.id, address: wallet.address };
    } else {
      // Create new wallet
      const res = await fetch(`${PRIVY_API_BASE}/wallets`, {
        method: 'POST',
        headers: authHeaders(creds),
        body: JSON.stringify({ chain_type: 'ethereum' }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to create wallet: ${res.status} ${text}`);
      }
      const wallet = await res.json() as { id: string; address: string };
      session = { walletId: wallet.id, address: wallet.address };
      console.log(`Created new Privy wallet`);
    }

    writeSession(session);
    console.log(`Address: ${session.address}`);
    console.log(`Wallet ID: ${session.walletId}`);
    console.log(`Session saved to ${sessionPath()}`);
  },

  async logout(_cfg: ResolvedConfig): Promise<void> {
    const session = readSession();
    if (!session) {
      console.log('Not logged in to Privy.');
      return;
    }
    deleteSession();
    console.log(`Logged out of Privy (${session.address}).`);
  },

  async status(_cfg: ResolvedConfig, opts: GlobalOptions): Promise<void> {
    const session = readSession();
    if (opts.json) {
      console.log(jsonStringify({
        provider: 'privy',
        loggedIn: !!session,
        address: session?.address ?? null,
        walletId: session?.walletId ?? null,
      }));
      return;
    }
    console.log('Provider: privy');
    if (session) {
      console.log(`Address:   ${session.address}`);
      console.log(`Wallet ID: ${session.walletId}`);
    } else {
      console.log('Status:    not logged in');
      console.log('Run `radius-cli --wallet privy wallet login` to set up Privy.');
    }
  },

  async getAccount(_cfg: ResolvedConfig): Promise<LocalAccount> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to Privy. Run `radius-cli --wallet privy wallet login` first.',
      );
    }
    const creds = await resolveCredentials();
    return buildPrivyAccount(session, creds);
  },

  async getAddress(_cfg: ResolvedConfig): Promise<Address> {
    const session = readSession();
    if (!session) {
      throw new Error(
        'Not logged in to Privy. Run `radius-cli --wallet privy wallet login` first.',
      );
    }
    return session.address as Address;
  },

  // Privy uses server-side MPC — no exportable private key.
  // Omitting exportPrivateKey makes wallet.ts throw the appropriate error.
};
