import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { radiusDir } from '../config.js';

export function providerSessionPath(fileName: string): string {
  return join(radiusDir(), fileName);
}

export function readProviderSessionFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readProviderSession<T>(fileName: string): T | null {
  return readProviderSessionFile<T>(providerSessionPath(fileName));
}

export function writeProviderSession<T>(fileName: string, session: T): void {
  const dir = radiusDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(providerSessionPath(fileName), JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function deleteProviderSession(fileName: string): void {
  const path = providerSessionPath(fileName);
  if (existsSync(path)) unlinkSync(path);
}

export function moveProviderSession(fromFileName: string, toFileName: string): string | null {
  const fromPath = providerSessionPath(fromFileName);
  if (!existsSync(fromPath)) return null;
  const toPath = providerSessionPath(toFileName);
  renameSync(fromPath, toPath);
  return toPath;
}
