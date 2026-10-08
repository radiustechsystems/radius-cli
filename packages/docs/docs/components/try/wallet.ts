/**
 * Shared testnet wallet for the interactive "Try Radius" components.
 *
 * One throwaway private key lives in this browser's localStorage, so every component on every
 * page uses the same wallet. State is a module-level store read with useSyncExternalStore; no
 * provider is needed because the components are siblings in MDX.
 *
 * radius-sdk and viem are imported dynamically on first use, so pages pay for them only when a
 * reader clicks something. Payments and the faucet go through same-origin Pages Functions
 * (worker/index.ts) because the faucet API sends no CORS headers.
 */
/// <reference types="vite/client" />
import { useSyncExternalStore } from 'react';
import type { AccountBalances, RadiusFetch, RadiusFetchOptions } from 'radius-sdk/client';

const KEY_STORAGE = 'radius-docs-testnet-key';

/**
 * URL of the Pages Function routes, under the site's base path: `/` in production, `/docs/` on a
 * sub-path preview (Vocs passes `basePath` to Vite as `base`). `import.meta.env` is undefined when
 * Vocs loads this module in Node for `toMarkdown`, hence the optional chaining.
 */
const sitePrefix = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
export const tryApiUrl = (path: string) => `${sitePrefix}/api/try${path}`;
export const TESTNET_EXPLORER_URL = 'https://testnet.radiustech.xyz';

export type WalletState = {
  /** False until the first client render has read localStorage. */
  ready: boolean;
  address?: `0x${string}`;
  balances?: AccountBalances;
  balancesError?: string;
  loadingBalances: boolean;
};

let state: WalletState = { ready: false, loadingBalances: false };
const listeners = new Set<() => void>();
const SERVER_STATE: WalletState = { ready: false, loadingBalances: false };

function setState(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function readKey(): `0x${string}` | undefined {
  try {
    const key = localStorage.getItem(KEY_STORAGE);
    return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : undefined;
  } catch {
    return undefined;
  }
}

function writeKey(key: `0x${string}` | undefined) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage blocked (private mode): the wallet lasts until the page is closed.
  }
}

let memoryKey: `0x${string}` | undefined;
const currentKey = () => readKey() ?? memoryKey;

async function addressOf(key: `0x${string}`) {
  const { privateKeyToAccount } = await import('viem/accounts');
  return privateKeyToAccount(key).address;
}

async function load() {
  const key = currentKey();
  if (!key) {
    setState({ ready: true, address: undefined, balances: undefined, balancesError: undefined });
    return;
  }
  const address = await addressOf(key);
  setState({ ready: true, address, balances: address === state.address ? state.balances : undefined });
  void refreshBalances();
}

let initialised = false;
function init() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  void load();
  // Another tab created, replaced or removed the wallet.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY_STORAGE) void load();
  });
}

function subscribe(listener: () => void) {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}

/**
 * A radius-sdk paying fetch for the stored key, on testnet, with the faucet proxied through the
 * docs origin. Created per action so options such as the per-request limit always apply.
 */
export async function radiusFetch(
  options: Partial<Omit<RadiusFetchOptions, 'signer' | 'network'>> = {},
): Promise<RadiusFetch> {
  const key = currentKey();
  if (!key) throw new Error('Create a testnet wallet first.');
  const { createRadiusFetch } = await import('radius-sdk/client');
  return createRadiusFetch({
    maxPerRequest: '0.01 SBC',
    ...options,
    network: 'testnet',
    signer: key,
    faucetUrl: `${location.origin}${tryApiUrl('/faucet')}`,
  });
}

export async function createWallet() {
  const { generatePrivateKey } = await import('viem/accounts');
  const key = generatePrivateKey();
  memoryKey = key;
  writeKey(key);
  await load();
}

export function exportKey(): `0x${string}` | undefined {
  return currentKey();
}

export async function resetWallet() {
  memoryKey = undefined;
  writeKey(undefined);
  await load();
}

export async function refreshBalances() {
  if (!currentKey()) return;
  setState({ loadingBalances: true });
  try {
    const balances = await (await radiusFetch()).balances();
    setState({ balances, balancesError: undefined, loadingBalances: false });
  } catch (error) {
    setState({ balancesError: errorMessage(error), loadingBalances: false });
  }
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error instanceof Error) {
    return `${error.message} (${String((error as { code: unknown }).code)})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Rounds a decimal string for display: "0.000899988168095488" → "0.0009". */
export function roundAmount(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: false }) : value;
}

export function shortHex(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export const txUrl = (hash: string) => `${TESTNET_EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${TESTNET_EXPLORER_URL}/address/${address}`;

/** JSON.stringify that prints bigints. */
export function toJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
