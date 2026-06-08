import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAddress, type Address } from 'viem';
import { chainFor, DEFAULT_SBC_ADDRESS } from './chains.js';
import type { GlobalOptions, NetworkName, ResolvedConfig, WalletProviderName } from '../types.js';

const VALID_WALLET_PROVIDERS: WalletProviderName[] = ['keystore', 'cdp', 'para', 'privy', 'proxy'];

const RADIUS_DIR = process.env.RADIUS_HOME ?? join(homedir(), '.radius');
const CONFIG_PATH = join(RADIUS_DIR, 'config.json');
const DEFAULT_KEYSTORE_PATH = join(RADIUS_DIR, 'keystore.json');

interface ProviderConfig {
  [key: string]: string | undefined;
}

interface FileConfig {
  network?: NetworkName;
  rpcUrl?: string;
  sbcAddress?: string;
  rusdAddress?: string;
  cachedAddress?: string;
  passwordless?: boolean;
  wallet?: WalletProviderName;
  providers?: Record<string, ProviderConfig>;
}

function readFileConfig(): FileConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

function pickAddress(value: string | undefined, label: string): Address | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${label} is not a valid 0x address: ${value}`);
  return value;
}

export function resolveConfig(opts: GlobalOptions): ResolvedConfig {
  const file = readFileConfig();

  const networkRaw = opts.network ?? process.env.RADIUS_NETWORK ?? file.network ?? 'mainnet';
  if (networkRaw !== 'mainnet' && networkRaw !== 'testnet') {
    throw new Error(`--network must be 'mainnet' or 'testnet' (got '${networkRaw}')`);
  }
  const network = networkRaw as NetworkName;
  const chain = chainFor(network);

  const rpcUrl = opts.rpcUrl ?? process.env.RADIUS_RPC_URL ?? file.rpcUrl ?? chain.rpcUrls.default.http[0];

  const sbcAddress =
    pickAddress(opts.sbc ?? process.env.RADIUS_SBC_ADDRESS ?? file.sbcAddress, 'SBC address') ??
    DEFAULT_SBC_ADDRESS;
  const rusdAddress = pickAddress(
    opts.rusd ?? process.env.RADIUS_RUSD_ADDRESS ?? file.rusdAddress,
    'RUSD address',
  );

  const keystorePath = process.env.RADIUS_KEYSTORE_PATH ?? DEFAULT_KEYSTORE_PATH;
  const password = process.env.RADIUS_PASSWORD;

  const walletRaw = opts.wallet ?? process.env.RADIUS_WALLET ?? file.wallet ?? 'keystore';
  if (!VALID_WALLET_PROVIDERS.includes(walletRaw as WalletProviderName)) {
    throw new Error(
      `--wallet must be one of ${VALID_WALLET_PROVIDERS.join(', ')} (got '${walletRaw}')`,
    );
  }
  const walletProvider = walletRaw as WalletProviderName;

  return { network, chain, rpcUrl, sbcAddress, rusdAddress, keystorePath, password, walletProvider };
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function radiusDir(): string {
  return RADIUS_DIR;
}

export function readCachedAddress(): Address | undefined {
  const file = readFileConfig();
  return pickAddress(file.cachedAddress, 'cached address');
}

function writeFileConfig(file: FileConfig): void {
  if (!existsSync(RADIUS_DIR)) mkdirSync(RADIUS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function writeCachedAddress(address: Address): void {
  const file = readFileConfig();
  file.cachedAddress = address;
  writeFileConfig(file);
}

export function readPasswordless(): boolean {
  return readFileConfig().passwordless === true;
}

export function writePasswordless(passwordless: boolean): void {
  const file = readFileConfig();
  if (passwordless) file.passwordless = true;
  else delete file.passwordless;
  writeFileConfig(file);
}

export function readWalletProvider(): WalletProviderName {
  return readFileConfig().wallet ?? 'keystore';
}

export function writeWalletProvider(provider: WalletProviderName): void {
  const file = readFileConfig();
  if (provider === 'keystore') delete file.wallet;
  else file.wallet = provider;
  writeFileConfig(file);
}

export function readProviderConfig(provider: string): ProviderConfig {
  return readFileConfig().providers?.[provider] ?? {};
}

export function writeProviderConfig(provider: string, update: Partial<ProviderConfig>): void {
  const file = readFileConfig();
  if (!file.providers) file.providers = {};
  file.providers[provider] = { ...file.providers[provider], ...update };
  writeFileConfig(file);
}

export function deleteProviderConfig(provider: string): void {
  const file = readFileConfig();
  if (file.providers) {
    delete file.providers[provider];
    if (Object.keys(file.providers).length === 0) delete file.providers;
  }
  writeFileConfig(file);
}
