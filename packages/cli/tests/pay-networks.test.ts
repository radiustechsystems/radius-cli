import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../src/types.js';

// config.ts reads RADIUS_HOME at import time, so point it at a scratch directory first.
const home = mkdtempSync(join(tmpdir(), 'radius-cli-pay-networks-'));
process.env.RADIUS_HOME = home;
const { resolveConfig, resolvePayNetworks } = await import('../src/lib/config.js');

const names = (cfg: ResolvedConfig, flag?: string) => resolvePayNetworks(cfg, flag).map((n) => n.name);

describe('resolvePayNetworks', () => {
  let mainnet: ResolvedConfig;
  let testnet: ResolvedConfig;
  beforeAll(() => {
    mainnet = resolveConfig({ network: 'mainnet' });
    testnet = resolveConfig({ network: 'testnet', rpcUrl: 'https://rpc.example/radius' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    writeFileSync(join(home, 'config.json'), '{}');
  });

  it('pays on Radius only by default', () => {
    expect(names(mainnet)).toEqual(['radius']);
    expect(names(testnet)).toEqual(['radius-testnet']);
  });

  it('pairs each network with mainnet or testnet, in the order given', () => {
    expect(names(mainnet, 'radius,base')).toEqual(['radius', 'base']);
    expect(names(testnet, ' base , radius ,base')).toEqual(['base-sepolia', 'radius-testnet']);
  });

  it('applies --rpc-url to Radius and the matching Base RPC setting to Base', () => {
    vi.stubEnv('RADIUS_BASE_RPC_URL', 'https://rpc.example/base');
    vi.stubEnv('RADIUS_BASE_SEPOLIA_RPC_URL', 'https://rpc.example/base-sepolia');
    const [radius, sepolia] = resolvePayNetworks(testnet, 'radius,base');
    expect(radius.rpcUrl).toBe('https://rpc.example/radius');
    expect(sepolia.rpcUrl).toBe('https://rpc.example/base-sepolia');
    expect(resolvePayNetworks(mainnet, 'base')[0].rpcUrl).toBe('https://rpc.example/base');
  });

  it('never uses the Base mainnet RPC for Base Sepolia', () => {
    vi.stubEnv('RADIUS_BASE_RPC_URL', 'https://rpc.example/base');
    expect(resolvePayNetworks(testnet, 'base')[0].rpcUrl).toBe('https://sepolia.base.org');
  });

  it('reads RADIUS_PAY_NETWORKS, then the config file, below the flag', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ payNetworks: ['base'], rpcUrls: { base: 'https://rpc.example/file', 'base-sepolia': 'https://rpc.example/file-sepolia' } }));
    expect(names(mainnet)).toEqual(['base']);
    expect(resolvePayNetworks(mainnet)[0].rpcUrl).toBe('https://rpc.example/file');
    expect(resolvePayNetworks(testnet)[0].rpcUrl).toBe('https://rpc.example/file-sepolia');
    vi.stubEnv('RADIUS_PAY_NETWORKS', 'radius,base');
    expect(names(mainnet)).toEqual(['radius', 'base']);
    expect(names(mainnet, 'radius')).toEqual(['radius']);
  });

  it('rejects unknown and empty lists', () => {
    expect(() => resolvePayNetworks(mainnet, 'radius,polygon')).toThrow(/unknown network 'polygon'/);
    expect(() => resolvePayNetworks(mainnet, ' , ')).toThrow(/at least one network/);
  });
});
