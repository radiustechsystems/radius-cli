import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address, type Hex } from 'viem';

export function keystoreExists(path: string): boolean {
  return existsSync(path);
}

export async function saveKeystore(path: string, privateKey: Hex, password: string): Promise<Address> {
  const wallet = new Wallet(privateKey);
  const json = await wallet.encrypt(password);

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, json, { mode: 0o600 });

  return wallet.address as Address;
}

export async function loadKeystorePrivateKey(path: string, password: string): Promise<Hex> {
  if (!existsSync(path)) {
    throw new Error(`No keystore at ${path}. Run \`radius wallet new\` or \`radius wallet import\` first.`);
  }
  const json = readFileSync(path, 'utf8');
  const wallet = await Wallet.fromEncryptedJson(json, password);
  return wallet.privateKey as Hex;
}

export async function loadAccount(path: string, password: string) {
  const pk = await loadKeystorePrivateKey(path, password);
  return privateKeyToAccount(pk);
}

export function readKeystoreAddress(path: string): Address | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as { address?: string };
    if (!obj.address) return undefined;
    const addr = obj.address.startsWith('0x') ? obj.address : `0x${obj.address}`;
    return getAddress(addr);
  } catch {
    return undefined;
  }
}
