import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFor } from '../src/lib/chains.js';
import type { ResolvedConfig, WalletProviderName } from '../src/types.js';

// config.ts captures RADIUS_HOME at module load, so isolate ~/.radius before
// dynamically importing anything that transitively loads it.
const radiusHome = mkdtempSync(join(tmpdir(), 'radius-cli-providers-'));
process.env.RADIUS_HOME = radiusHome;

const { getProvider } = await import('../src/lib/providers/index.js');
const { requireAccount, getOwnAddress } = await import('../src/lib/account.js');

function makeCfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    network: 'testnet',
    chain: chainFor('testnet'),
    rpcUrl: 'http://localhost:0',
    keystorePath: join(radiusHome, 'keystore.json'),
    walletProvider: 'keystore',
    ...overrides,
  };
}

describe('stub providers (cdp, para, privy)', () => {
  const stubs: WalletProviderName[] = ['cdp', 'para', 'privy'];

  for (const name of stubs) {
    it(`${name}: getAccount rejects with "not yet implemented"`, async () => {
      await expect(getProvider(name).getAccount(makeCfg({ walletProvider: name }))).rejects.toThrow(
        /not yet implemented/,
      );
    });

    it(`${name}: getAddress rejects with "not yet implemented"`, async () => {
      await expect(getProvider(name).getAddress(makeCfg({ walletProvider: name }))).rejects.toThrow(
        /not yet implemented/,
      );
    });

    it(`${name}: does not expose exportPrivateKey (remote key material)`, () => {
      expect(getProvider(name).exportPrivateKey).toBeUndefined();
    });
  }
});

describe('keystore provider', () => {
  const provider = getProvider('keystore');

  it('auto-creates a keystore on first getAddress and reuses it for getAccount', async () => {
    const cfg = makeCfg();
    expect(existsSync(cfg.keystorePath)).toBe(false);

    const address = await provider.getAddress(cfg);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(cfg.keystorePath)).toBe(true);

    // Passwordless flag was persisted, so this must not prompt.
    const account = await provider.getAccount(cfg);
    expect(account.address.toLowerCase()).toBe(address.toLowerCase());
  }, 20_000);

  it('exportPrivateKey returns the key backing the keystore address', async () => {
    const cfg = makeCfg();
    expect(provider.exportPrivateKey).toBeDefined();
    const pk = await provider.exportPrivateKey!(cfg);
    const address = await provider.getAddress(cfg);
    expect(privateKeyToAccount(pk).address.toLowerCase()).toBe(address.toLowerCase());
  }, 20_000);

  it('auto-creates with an explicit password and rejects a wrong one', async () => {
    const cfg = makeCfg({
      keystorePath: join(radiusHome, 'keystore-pw.json'),
      password: 'correct-horse-battery-staple',
    });

    const account = await provider.getAccount(cfg);
    const reloaded = await provider.getAccount(cfg);
    expect(reloaded.address).toBe(account.address);

    await expect(provider.getAccount({ ...cfg, password: 'wrong' })).rejects.toThrow();
  }, 60_000);
});

describe('account shims (requireAccount / getOwnAddress)', () => {
  const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const PK_ADDRESS = privateKeyToAccount(PK).address;

  it('dispatch to the selected provider', async () => {
    const cfg = makeCfg({ walletProvider: 'cdp' });
    await expect(requireAccount(cfg, undefined)).rejects.toThrow(/not yet implemented/);
    await expect(getOwnAddress(cfg, undefined)).rejects.toThrow(/not yet implemented/);
  });

  it('--private-key overrides the provider entirely', async () => {
    const cfg = makeCfg({ walletProvider: 'cdp' });
    const account = await requireAccount(cfg, PK);
    expect(account.address).toBe(PK_ADDRESS);
    expect(await getOwnAddress(cfg, PK)).toBe(PK_ADDRESS);
  });

  it('normalizes a private key missing its 0x prefix', async () => {
    const account = await requireAccount(makeCfg(), PK.slice(2));
    expect(account.address).toBe(PK_ADDRESS);
  });
});
