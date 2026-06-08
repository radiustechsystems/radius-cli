import {
  type Address,
  type Hex,
  type LocalAccount,
  isAddress,
  isHex,
  toHex,
} from 'viem';
import { toAccount } from 'viem/accounts';
import { readProviderConfig } from '../config.js';
import { jsonStringify } from '../format.js';
import { signLegacyTransaction } from './remoteSigning.js';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';
import type { WalletProvider } from './types.js';

interface ProxyConfig {
  url: string;
  alias: string;
  token?: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

interface PartialProxyConfig {
  url?: string;
  alias?: string;
  token?: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

interface ProxyAddressResponse {
  provider?: string;
  alias?: string;
  address?: string;
}

interface ProxyStatusResponse {
  provider?: string;
  alias?: string;
  status?: string;
  address?: string | null;
}

interface ProxyCapabilitiesResponse {
  provider?: string;
  alias?: string;
  capabilities?: Record<string, boolean>;
}

interface ProxySignatureResponse {
  provider?: string;
  alias?: string;
  signature?: string;
}

function readProxyConfig(): PartialProxyConfig {
  const config = readProviderConfig('proxy');
  return {
    url: process.env.RADIUS_WALLET_PROXY_URL ?? config.url,
    alias: process.env.RADIUS_WALLET_ALIAS ?? config.alias,
    token: process.env.RADIUS_WALLET_PROXY_TOKEN ?? config.token,
    accessClientId: process.env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  };
}

function requireProxyConfig(): ProxyConfig {
  const config = readProxyConfig();
  const missing = [
    !config.url && 'RADIUS_WALLET_PROXY_URL',
    !config.alias && 'RADIUS_WALLET_ALIAS',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Proxy wallet not configured (missing: ${missing.join(', ')}).\n` +
      'Set RADIUS_WALLET_PROXY_URL and RADIUS_WALLET_ALIAS,\n' +
      'or configure providers.proxy.url and providers.proxy.alias in ~/.radius/config.json.',
    );
  }

  if (Boolean(config.accessClientId) !== Boolean(config.accessClientSecret)) {
    throw new Error(
      'Cloudflare Access service token is incomplete. Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.',
    );
  }

  return {
    url: config.url!.replace(/\/+$/, ''),
    alias: config.alias!,
    token: config.token,
    accessClientId: config.accessClientId,
    accessClientSecret: config.accessClientSecret,
  };
}

function walletUrl(config: ProxyConfig, operation: string): string {
  return `${config.url}/v1/wallets/${encodeURIComponent(config.alias)}/${operation}`;
}

function requestHeaders(config: ProxyConfig, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.accessClientId) headers['CF-Access-Client-Id'] = config.accessClientId;
  if (config.accessClientSecret) headers['CF-Access-Client-Secret'] = config.accessClientSecret;
  return headers;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function proxyRequest<T>(
  config: ProxyConfig,
  operation: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(walletUrl(config, operation), {
    method: init.method,
    headers: requestHeaders(config, hasBody),
    body: hasBody ? JSON.stringify(init.body, jsonReplacer) : undefined,
  });

  if (!res.ok) {
    const detail = await parseProxyError(res);
    throw new Error(`Proxy wallet ${operation} failed (${res.status}): ${detail}`);
  }

  return await res.json() as T;
}

async function parseProxyError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText || 'request failed';
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message) {
      return parsed.error.code
        ? `${parsed.error.code}: ${parsed.error.message}`
        : parsed.error.message;
    }
  } catch {
    // Fall through to raw response text.
  }
  return text;
}

async function fetchAddress(config: ProxyConfig): Promise<Address> {
  const data = await proxyRequest<ProxyAddressResponse>(config, 'address', { method: 'GET' });
  if (!data.address || !isAddress(data.address)) {
    throw new Error('Proxy wallet address response did not include a valid 0x address.');
  }
  return data.address as Address;
}

function normalizeMessage(message: string | { raw: Hex | Uint8Array }): string {
  if (typeof message === 'string') return message;
  if (message.raw instanceof Uint8Array) return toHex(message.raw);
  return message.raw;
}

function requireSignature(data: ProxySignatureResponse, operation: string): Hex {
  if (!data.signature || !isHex(data.signature)) {
    throw new Error(`Proxy wallet ${operation} response did not include a valid signature.`);
  }
  return data.signature as Hex;
}

async function signHash(config: ProxyConfig, hash: Hex): Promise<Hex> {
  const data = await proxyRequest<ProxySignatureResponse>(config, 'sign-transaction', {
    method: 'POST',
    body: { hash },
  });
  return requireSignature(data, 'sign-transaction');
}

function buildProxyAccount(config: ProxyConfig, address: Address): LocalAccount {
  return toAccount({
    address,

    async sign({ hash }) {
      return signHash(config, hash);
    },

    async signMessage({ message }) {
      const data = await proxyRequest<ProxySignatureResponse>(config, 'sign-message', {
        method: 'POST',
        body: { message: normalizeMessage(message) },
      });
      return requireSignature(data, 'sign-message');
    },

    async signTransaction(tx) {
      return signLegacyTransaction(tx, (hash) => signHash(config, hash));
    },

    async signTypedData(typedData) {
      const data = await proxyRequest<ProxySignatureResponse>(config, 'sign-typed-data', {
        method: 'POST',
        body: { typedData },
      });
      return requireSignature(data, 'sign-typed-data');
    },
  });
}

function statusUrl(config: PartialProxyConfig): string | null {
  return config.url ? config.url.replace(/\/+$/, '') : null;
}

export const proxyProvider: WalletProvider = {
  async status(_cfg: ResolvedConfig, opts: GlobalOptions): Promise<void> {
    const rawConfig = readProxyConfig();
    const configured = Boolean(rawConfig.url && rawConfig.alias);
    let loggedIn = false;
    let remoteProvider: string | null = null;
    let remoteStatus: string | null = null;
    let address: string | null = null;
    let capabilities: Record<string, boolean> | null = null;
    let error: string | null = null;

    if (configured) {
      try {
        const config = requireProxyConfig();
        const status = await proxyRequest<ProxyStatusResponse>(config, 'status', { method: 'GET' });
        loggedIn = true;
        remoteProvider = status.provider ?? null;
        remoteStatus = status.status ?? null;
        address = status.address && isAddress(status.address) ? status.address : null;

        try {
          const caps = await proxyRequest<ProxyCapabilitiesResponse>(config, 'capabilities', { method: 'GET' });
          capabilities = caps.capabilities ?? null;
          remoteProvider = remoteProvider ?? caps.provider ?? null;
        } catch {
          capabilities = null;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    if (opts.json) {
      console.log(jsonStringify({
        provider: 'proxy',
        configured,
        loggedIn,
        alias: rawConfig.alias ?? null,
        url: statusUrl(rawConfig),
        remoteProvider,
        remoteStatus,
        address,
        capabilities,
        error,
      }));
      return;
    }

    console.log('Provider: proxy');
    console.log(`Status:   ${configured ? (loggedIn ? 'configured' : 'unreachable') : 'not configured'}`);
    if (rawConfig.alias) console.log(`Alias:    ${rawConfig.alias}`);
    if (rawConfig.url) console.log(`URL:      ${statusUrl(rawConfig)}`);
    if (remoteProvider) console.log(`Remote:   ${remoteProvider}`);
    if (remoteStatus) console.log(`Remote status: ${remoteStatus}`);
    if (address) console.log(`Address:  ${address}`);
    if (capabilities) {
      console.log(`Capabilities: signMessage=${!!capabilities.signMessage}, signTypedData=${!!capabilities.signTypedData}, signTransaction=${!!capabilities.signTransaction}`);
    }
    if (error) console.log(`Error:    ${error}`);
    if (!configured) {
      console.log('Set RADIUS_WALLET_PROXY_URL and RADIUS_WALLET_ALIAS to use the proxy provider.');
    }
  },

  async getAccount(_cfg: ResolvedConfig): Promise<LocalAccount> {
    const config = requireProxyConfig();
    const address = await fetchAddress(config);
    return buildProxyAccount(config, address);
  },

  async getAddress(_cfg: ResolvedConfig): Promise<Address> {
    return fetchAddress(requireProxyConfig());
  },

  // The proxy worker is a remote secret boundary. Private key export is intentionally unsupported.
};
