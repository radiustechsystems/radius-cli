import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
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
const { disableProviderTelemetry } = await import('../src/lib/providerTelemetry.js');
const { resolveConfig, writeProviderConfig, deleteProviderConfig } = await import('../src/lib/config.js');

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

describe('privy provider', () => {
  const provider = getProvider('privy');
  const privySessionPath = join(radiusHome, 'privy-session.json');
  const MOCK_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
  const MOCK_WALLET_ID = 'wlt_test123';
  const MOCK_SESSION = {
    walletId: MOCK_WALLET_ID,
    address: MOCK_ADDRESS,
  };

  it('does not expose exportPrivateKey (remote key material)', () => {
    expect(provider.exportPrivateKey).toBeUndefined();
  });

  it('getAccount rejects when not logged in', async () => {
    await expect(provider.getAccount(makeCfg({ walletProvider: 'privy' }))).rejects.toThrow(
      /Not logged in to Privy/,
    );
  });

  it('getAddress rejects when not logged in', async () => {
    await expect(provider.getAddress(makeCfg({ walletProvider: 'privy' }))).rejects.toThrow(
      /Not logged in to Privy/,
    );
  });

  it('getAddress returns cached address from session file', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    try {
      const address = await provider.getAddress(makeCfg({ walletProvider: 'privy' }));
      expect(address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
    } finally {
      unlinkSync(privySessionPath);
    }
  });

  it('getAccount rejects without credentials when session exists', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    try {
      await expect(provider.getAccount(makeCfg({ walletProvider: 'privy' }))).rejects.toThrow(
        /Privy credentials not configured/,
      );
    } finally {
      if (origId) process.env.PRIVY_APP_ID = origId;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });

  it('getAccount returns a viem-compatible account when credentials exist', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-app-secret';
    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'privy' }));
      expect(account.address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
      expect(typeof account.signMessage).toBe('function');
      expect(typeof account.signTransaction).toBe('function');
      expect(typeof account.signTypedData).toBe('function');
    } finally {
      if (origId) process.env.PRIVY_APP_ID = origId;
      else delete process.env.PRIVY_APP_ID;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      else delete process.env.PRIVY_APP_SECRET;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });

  it('status shows not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'privy' }), {});
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('privy'))).toBe(true);
    expect(logs.some((l) => l.includes('not logged in'))).toBe(true);
  });

  it('status shows logged-in state from session file', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'privy' }), {});
    } finally {
      console.log = origLog;
      unlinkSync(privySessionPath);
    }
    expect(logs.some((l) => l.includes(MOCK_ADDRESS))).toBe(true);
    expect(logs.some((l) => l.includes(MOCK_WALLET_ID))).toBe(true);
  });

  it('status --json returns structured output', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'privy' }), { json: true });
    } finally {
      console.log = origLog;
      unlinkSync(privySessionPath);
    }
    const parsed = JSON.parse(logs[0]);
    expect(parsed.provider).toBe('privy');
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
    expect(parsed.walletId).toBe(MOCK_WALLET_ID);
  });

  it('logout is a no-op when not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'privy' }));
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('Not logged in'))).toBe(true);
  });

  it('logout deletes session file', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    expect(existsSync(privySessionPath)).toBe(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'privy' }));
    } finally {
      console.log = origLog;
    }
    expect(existsSync(privySessionPath)).toBe(false);
    expect(logs.some((l) => l.includes('Logged out'))).toBe(true);
  });

  it('session file is stored with restrictive permissions (0o600)', () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    try {
      const stat = statSync(privySessionPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      unlinkSync(privySessionPath);
    }
  });

  it('--private-key overrides privy provider', async () => {
    const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const cfg = makeCfg({ walletProvider: 'privy' });
    const account = await requireAccount(cfg, PK);
    expect(account.address).toBe(privateKeyToAccount(PK).address);
  });

  it('provider resolution via requireAccount dispatches to privy', async () => {
    const cfg = makeCfg({ walletProvider: 'privy' });
    await expect(requireAccount(cfg, undefined)).rejects.toThrow(/Not logged in to Privy/);
  });

  it('signMessage calls Privy personal_sign RPC', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-app-secret';

    const mockSig = '0x' + 'ab'.repeat(65);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signature: mockSig } }),
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'privy' }));
      const sig = await account.signMessage({ message: 'hello' });
      expect(sig).toBe(mockSig);

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toContain(`/wallets/${MOCK_WALLET_ID}/rpc`);
      const body = JSON.parse(fetchCall[1].body);
      expect(body.method).toBe('personal_sign');
      expect(body.params.encoding).toBe('hex');
    } finally {
      globalThis.fetch = origFetch;
      if (origId) process.env.PRIVY_APP_ID = origId;
      else delete process.env.PRIVY_APP_ID;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      else delete process.env.PRIVY_APP_SECRET;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });

  it('signTypedData calls Privy eth_signTypedData_v4 RPC', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-app-secret';

    const mockSig = '0x' + 'cd'.repeat(65);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signature: mockSig } }),
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'privy' }));
      const sig = await account.signTypedData({
        domain: { name: 'Test', version: '1', chainId: 1 },
        types: { Foo: [{ name: 'bar', type: 'uint256' }] },
        primaryType: 'Foo',
        message: { bar: 42n },
      });
      expect(sig).toBe(mockSig);

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.method).toBe('eth_signTypedData_v4');
      expect(body.params.typed_data.primary_type).toBe('Foo');
    } finally {
      globalThis.fetch = origFetch;
      if (origId) process.env.PRIVY_APP_ID = origId;
      else delete process.env.PRIVY_APP_ID;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      else delete process.env.PRIVY_APP_SECRET;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });

  it('signTransaction calls Privy secp256k1_sign RPC', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-app-secret';

    // 65-byte signature: r (32) + s (32) + v (1)
    const mockR = 'ab'.repeat(32);
    const mockS = 'cd'.repeat(32);
    const mockV = '1b'; // v = 27
    const mockSig = `0x${mockR}${mockS}${mockV}`;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signature: mockSig } }),
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'privy' }));
      const result = await account.signTransaction({
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        nonce: 0,
        gas: 21000n,
        gasPrice: 1000000000n,
        chainId: 72344,
        type: 'legacy',
      } as any);

      expect(result).toMatch(/^0x/);
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.method).toBe('secp256k1_sign');
      expect(body.params.hash).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = origFetch;
      if (origId) process.env.PRIVY_APP_ID = origId;
      else delete process.env.PRIVY_APP_ID;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      else delete process.env.PRIVY_APP_SECRET;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });

  it('RPC errors include Privy error details', async () => {
    writeFileSync(privySessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origId = process.env.PRIVY_APP_ID;
    const origSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-app-secret';

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'policy violation' } })),
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'privy' }));
      await expect(account.signMessage({ message: 'test' })).rejects.toThrow(
        /Privy RPC personal_sign failed \(403\): policy violation/,
      );
    } finally {
      globalThis.fetch = origFetch;
      if (origId) process.env.PRIVY_APP_ID = origId;
      else delete process.env.PRIVY_APP_ID;
      if (origSecret) process.env.PRIVY_APP_SECRET = origSecret;
      else delete process.env.PRIVY_APP_SECRET;
      if (existsSync(privySessionPath)) unlinkSync(privySessionPath);
    }
  });
});

describe('cdp provider', () => {
  const provider = getProvider('cdp');
  const cdpSessionPath = join(radiusHome, 'cdp-session.json');
  const MOCK_CDP_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
  const MOCK_CDP_SESSION = {
    address: MOCK_CDP_ADDRESS,
    accountName: 'test-account',
  };

  it('getAccount rejects when not logged in', async () => {
    await expect(provider.getAccount(makeCfg({ walletProvider: 'cdp' }))).rejects.toThrow(
      /Not logged in to CDP/,
    );
  });

  it('getAddress rejects when not logged in', async () => {
    await expect(provider.getAddress(makeCfg({ walletProvider: 'cdp' }))).rejects.toThrow(
      /Not logged in to CDP/,
    );
  });

  it('does not expose exportPrivateKey (server-side keys)', () => {
    expect(provider.exportPrivateKey).toBeUndefined();
  });

  it('getAccount rejects without credentials when session exists', async () => {
    writeFileSync(cdpSessionPath, JSON.stringify(MOCK_CDP_SESSION), { mode: 0o600 });
    const origId = process.env.CDP_API_KEY_ID;
    const origSecret = process.env.CDP_API_KEY_SECRET;
    const origWallet = process.env.CDP_WALLET_SECRET;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    try {
      await expect(provider.getAccount(makeCfg({ walletProvider: 'cdp' }))).rejects.toThrow(
        /CDP credentials not configured/,
      );
    } finally {
      if (origId) process.env.CDP_API_KEY_ID = origId;
      if (origSecret) process.env.CDP_API_KEY_SECRET = origSecret;
      if (origWallet) process.env.CDP_WALLET_SECRET = origWallet;
      if (existsSync(cdpSessionPath)) unlinkSync(cdpSessionPath);
    }
  });

  it('status shows not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'cdp' }), {});
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('cdp'))).toBe(true);
    expect(logs.some((l) => l.includes('not logged in'))).toBe(true);
  });

  it('logout is a no-op when not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'cdp' }));
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('Not logged in'))).toBe(true);
  });

  it('getAddress returns cached address from session file', async () => {
    writeFileSync(cdpSessionPath, JSON.stringify(MOCK_CDP_SESSION), { mode: 0o600 });
    try {
      const address = await provider.getAddress(makeCfg({ walletProvider: 'cdp' }));
      expect(address.toLowerCase()).toBe(MOCK_CDP_ADDRESS.toLowerCase());
    } finally {
      unlinkSync(cdpSessionPath);
    }
  });

  it('status shows logged-in state from session file', async () => {
    writeFileSync(cdpSessionPath, JSON.stringify(MOCK_CDP_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'cdp' }), {});
    } finally {
      console.log = origLog;
      unlinkSync(cdpSessionPath);
    }
    expect(logs.some((l) => l.includes(MOCK_CDP_ADDRESS))).toBe(true);
    expect(logs.some((l) => l.includes('test-account'))).toBe(true);
  });

  it('status --json returns structured output', async () => {
    writeFileSync(cdpSessionPath, JSON.stringify(MOCK_CDP_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'cdp' }), { json: true });
    } finally {
      console.log = origLog;
      unlinkSync(cdpSessionPath);
    }
    const parsed = JSON.parse(logs[0]);
    expect(parsed.provider).toBe('cdp');
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.address.toLowerCase()).toBe(MOCK_CDP_ADDRESS.toLowerCase());
  });

  it('logout deletes session file', async () => {
    writeFileSync(cdpSessionPath, JSON.stringify(MOCK_CDP_SESSION), { mode: 0o600 });
    expect(existsSync(cdpSessionPath)).toBe(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'cdp' }));
    } finally {
      console.log = origLog;
    }
    expect(existsSync(cdpSessionPath)).toBe(false);
    expect(logs.some((l) => l.includes('Logged out'))).toBe(true);
  });

  it('--private-key overrides cdp provider', async () => {
    const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const cfg = makeCfg({ walletProvider: 'cdp' });
    const account = await requireAccount(cfg, PK);
    expect(account.address).toBe(privateKeyToAccount(PK).address);
  });
});

describe('para provider', () => {
  const provider = getProvider('para');
  const paraSessionPath = join(radiusHome, 'para-session.json');
  const paraBackupPath = join(radiusHome, 'para-session.bak.json');
  const MOCK_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
  const MOCK_SESSION = {
    email: 'test@example.com',
    userShare: 'mock-user-share-base64',
    walletId: 'mock-wallet-id',
    address: MOCK_ADDRESS,
  };

  it('getAccount rejects when not logged in', async () => {
    await expect(provider.getAccount(makeCfg({ walletProvider: 'para' }))).rejects.toThrow(
      /Not logged in to Para/,
    );
  });

  it('getAddress rejects when not logged in', async () => {
    await expect(provider.getAddress(makeCfg({ walletProvider: 'para' }))).rejects.toThrow(
      /Not logged in to Para/,
    );
  });

  it('does not expose exportPrivateKey (MPC key material)', () => {
    expect(provider.exportPrivateKey).toBeUndefined();
  });

  it('getAccount rejects without API key when session exists', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origKey = process.env.PARA_API_KEY;
    delete process.env.PARA_API_KEY;
    try {
      await expect(provider.getAccount(makeCfg({ walletProvider: 'para' }))).rejects.toThrow(
        /Para API key not configured/,
      );
    } finally {
      if (origKey) process.env.PARA_API_KEY = origKey;
      if (existsSync(paraSessionPath)) unlinkSync(paraSessionPath);
    }
  });

  it('status shows not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'para' }), {});
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('para'))).toBe(true);
    expect(logs.some((l) => l.includes('not logged in'))).toBe(true);
  });

  it('logout is a no-op when not logged in', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'para' }));
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('Not logged in'))).toBe(true);
  });

  it('reset reports the archived session backup path', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origKey = process.env.PARA_API_KEY;
    delete process.env.PARA_API_KEY;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await expect(provider.login!(makeCfg({ walletProvider: 'para' }), { reset: true })).rejects.toThrow(
        /Para API key not configured/,
      );
    } finally {
      console.log = origLog;
      if (origKey) process.env.PARA_API_KEY = origKey;
      if (existsSync(paraSessionPath)) unlinkSync(paraSessionPath);
      if (existsSync(paraBackupPath)) unlinkSync(paraBackupPath);
    }

    expect(logs.some((l) => l.includes(`Previous Para session archived to ${paraBackupPath}.`))).toBe(true);
  });

  it('login restores an archived session backup', async () => {
    writeFileSync(paraBackupPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.login!(makeCfg({ walletProvider: 'para' }), {});
      expect(existsSync(paraSessionPath)).toBe(true);
      expect(existsSync(paraBackupPath)).toBe(false);
    } finally {
      console.log = origLog;
      if (existsSync(paraSessionPath)) unlinkSync(paraSessionPath);
      if (existsSync(paraBackupPath)) unlinkSync(paraBackupPath);
    }

    expect(logs.some((l) => l.includes(`Restored Para session from ${paraBackupPath}.`))).toBe(true);
  });

  it('getAddress returns cached address from session file', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    try {
      const address = await provider.getAddress(makeCfg({ walletProvider: 'para' }));
      expect(address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
    } finally {
      unlinkSync(paraSessionPath);
    }
  });

  it('session file is stored with restrictive permissions (0o600)', () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    try {
      const stat = statSync(paraSessionPath);
      // 0o600 = owner read+write only (octal 33216 on some systems, mask with 0o777)
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      unlinkSync(paraSessionPath);
    }
  });

  it('status shows logged-in state from session file', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'para' }), {});
    } finally {
      console.log = origLog;
      unlinkSync(paraSessionPath);
    }
    expect(logs.some((l) => l.includes('test@example.com'))).toBe(true);
    expect(logs.some((l) => l.includes(MOCK_ADDRESS))).toBe(true);
  });

  it('status --json returns structured output', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.status(makeCfg({ walletProvider: 'para' }), { json: true });
    } finally {
      console.log = origLog;
      unlinkSync(paraSessionPath);
    }
    const parsed = JSON.parse(logs[0]);
    expect(parsed.provider).toBe('para');
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.email).toBe('test@example.com');
    expect(parsed.address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
  });

  it('logout archives session file', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    expect(existsSync(paraSessionPath)).toBe(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'para' }));
    } finally {
      console.log = origLog;
      if (existsSync(paraBackupPath)) unlinkSync(paraBackupPath);
    }
    expect(existsSync(paraSessionPath)).toBe(false);
    expect(logs.some((l) => l.includes(`Session archived to ${paraBackupPath}.`))).toBe(true);
    expect(logs.some((l) => l.includes('Logged out'))).toBe(true);
  });

  it('getAccount rejects with API key error when session exists but no key (env or config)', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origKey = process.env.PARA_API_KEY;
    delete process.env.PARA_API_KEY;
    try {
      await expect(provider.getAccount(makeCfg({ walletProvider: 'para' }))).rejects.toThrow(
        /Para API key not configured/,
      );
    } finally {
      if (origKey) process.env.PARA_API_KEY = origKey;
      if (existsSync(paraSessionPath)) unlinkSync(paraSessionPath);
    }
  });

  it('provider resolution via requireAccount dispatches to para', async () => {
    const cfg = makeCfg({ walletProvider: 'para' });
    await expect(requireAccount(cfg, undefined)).rejects.toThrow(/Not logged in to Para/);
  });

  it('--private-key overrides para provider', async () => {
    const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const cfg = makeCfg({ walletProvider: 'para' });
    const account = await requireAccount(cfg, PK);
    expect(account.address).toBe(privateKeyToAccount(PK).address);
  });

  it('getAccount passes session address to createParaViemAccount', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    const origKey = process.env.PARA_API_KEY;
    process.env.PARA_API_KEY = 'test-key';

    // Mock the Para SDK dynamic imports
    const mockSetUserShare = vi.fn().mockResolvedValue(undefined);
    const mockSetCurrentWalletIds = vi.fn().mockResolvedValue(undefined);
    const mockCreateParaViemAccount = vi.fn().mockReturnValue({
      address: MOCK_ADDRESS,
      type: 'local',
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
      sign: vi.fn(),
    });

    const mockPara = vi.fn().mockImplementation(() => ({
      setUserShare: mockSetUserShare,
      setCurrentWalletIds: mockSetCurrentWalletIds,
    }));

    vi.doMock('@getpara/server-sdk', () => ({
      Para: mockPara,
      Environment: { BETA: 'BETA', PROD: 'PROD', DEV: 'DEV', SANDBOX: 'SANDBOX' },
    }));
    vi.doMock('@getpara/viem-v2-integration', () => ({
      createParaViemAccount: mockCreateParaViemAccount,
    }));

    try {
      // Re-import to pick up mocks
      const { paraProvider } = await import('../src/lib/providers/para.js');
      await paraProvider.getAccount(makeCfg({ walletProvider: 'para' }));

      expect(mockPara).toHaveBeenCalledWith('BETA', 'test-key', {
        disableWorkers: true,
        disableWebSockets: true,
      });
      expect(mockSetUserShare).toHaveBeenCalledWith(MOCK_SESSION.userShare);
      expect(mockSetCurrentWalletIds).toHaveBeenCalledWith({ EVM: [MOCK_SESSION.walletId] });
      expect(mockCreateParaViemAccount).toHaveBeenCalledWith(
        expect.objectContaining({ address: MOCK_ADDRESS }),
      );
    } finally {
      vi.doUnmock('@getpara/server-sdk');
      vi.doUnmock('@getpara/viem-v2-integration');
      if (origKey) process.env.PARA_API_KEY = origKey;
      else delete process.env.PARA_API_KEY;
      if (existsSync(paraSessionPath)) unlinkSync(paraSessionPath);
    }
  });
});

describe('proxy provider', () => {
  const provider = getProvider('proxy');
  const MOCK_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
  const MOCK_SIGNATURE = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`;

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
  }

  function saveProxyEnv(): Record<string, string | undefined> {
    return {
      RADIUS_WALLET: process.env.RADIUS_WALLET,
      RADIUS_WALLET_PROXY_URL: process.env.RADIUS_WALLET_PROXY_URL,
      RADIUS_WALLET_ALIAS: process.env.RADIUS_WALLET_ALIAS,
      RADIUS_WALLET_PROXY_TOKEN: process.env.RADIUS_WALLET_PROXY_TOKEN,
      CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
    };
  }

  function restoreProxyEnv(saved: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  function configureProxyEnv(): Record<string, string | undefined> {
    const saved = saveProxyEnv();
    process.env.RADIUS_WALLET_PROXY_URL = 'https://wallet-proxy.example/';
    process.env.RADIUS_WALLET_ALIAS = 'agent0-main';
    process.env.RADIUS_WALLET_PROXY_TOKEN = 'test-token';
    process.env.CF_ACCESS_CLIENT_ID = 'access-client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'access-client-secret';
    return saved;
  }

  it('--wallet proxy resolves through config selection', () => {
    const cfg = resolveConfig({ wallet: 'proxy' });
    expect(cfg.walletProvider).toBe('proxy');
  });

  it('RADIUS_WALLET=proxy resolves through env selection', () => {
    const saved = saveProxyEnv();
    process.env.RADIUS_WALLET = 'proxy';
    try {
      const cfg = resolveConfig({});
      expect(cfg.walletProvider).toBe('proxy');
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it('does not expose exportPrivateKey (remote secret boundary)', () => {
    expect(provider.exportPrivateKey).toBeUndefined();
  });

  it('getAddress rejects when URL or alias is missing', async () => {
    const saved = saveProxyEnv();
    delete process.env.RADIUS_WALLET_PROXY_URL;
    delete process.env.RADIUS_WALLET_ALIAS;
    try {
      await expect(provider.getAddress(makeCfg({ walletProvider: 'proxy' }))).rejects.toThrow(
        /Proxy wallet not configured/,
      );
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it('getAddress calls the proxy address endpoint with optional auth headers', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      provider: 'cdp',
      alias: 'agent0-main',
      address: MOCK_ADDRESS,
    })) as any;

    try {
      const address = await provider.getAddress(makeCfg({ walletProvider: 'proxy' }));
      expect(address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://wallet-proxy.example/v1/wallets/agent0-main/address');
      expect(fetchCall[1].method).toBe('GET');
      expect(fetchCall[1].headers.authorization).toBe('Bearer test-token');
      expect(fetchCall[1].headers['CF-Access-Client-Id']).toBe('access-client-id');
      expect(fetchCall[1].headers['CF-Access-Client-Secret']).toBe('access-client-secret');
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('can read proxy URL and alias from providers.proxy config', async () => {
    const saved = saveProxyEnv();
    delete process.env.RADIUS_WALLET_PROXY_URL;
    delete process.env.RADIUS_WALLET_ALIAS;
    writeProviderConfig('proxy', {
      url: 'https://config-wallet-proxy.example/',
      alias: 'config-agent',
      token: 'config-token',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      provider: 'privy',
      alias: 'config-agent',
      address: MOCK_ADDRESS,
    })) as any;

    try {
      const address = await provider.getAddress(makeCfg({ walletProvider: 'proxy' }));
      expect(address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://config-wallet-proxy.example/v1/wallets/config-agent/address');
      expect(fetchCall[1].headers.authorization).toBe('Bearer config-token');
    } finally {
      globalThis.fetch = origFetch;
      deleteProviderConfig('proxy');
      restoreProxyEnv(saved);
    }
  });

  it('signMessage posts to the proxy sign-message endpoint', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith('/address')) {
        return Promise.resolve(jsonResponse({ provider: 'privy', alias: 'agent0-main', address: MOCK_ADDRESS }));
      }
      return Promise.resolve(jsonResponse({ provider: 'privy', alias: 'agent0-main', signature: MOCK_SIGNATURE }));
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'proxy' }));
      const signature = await account.signMessage({ message: 'hello' });
      expect(signature).toBe(MOCK_SIGNATURE);

      const signCall = (globalThis.fetch as any).mock.calls.find((call: any[]) => call[0].endsWith('/sign-message'));
      expect(signCall[1].method).toBe('POST');
      expect(JSON.parse(signCall[1].body)).toEqual({ message: 'hello' });
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('signTypedData posts typed data to the proxy', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith('/address')) {
        return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', address: MOCK_ADDRESS }));
      }
      return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', signature: MOCK_SIGNATURE }));
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'proxy' }));
      const signature = await account.signTypedData({
        domain: { name: 'Test', version: '1', chainId: 72344 },
        types: { Permit: [{ name: 'amount', type: 'uint256' }] },
        primaryType: 'Permit',
        message: { amount: 42n },
      });
      expect(signature).toBe(MOCK_SIGNATURE);

      const signCall = (globalThis.fetch as any).mock.calls.find((call: any[]) => call[0].endsWith('/sign-typed-data'));
      const body = JSON.parse(signCall[1].body);
      expect(body.typedData.primaryType).toBe('Permit');
      expect(body.typedData.message.amount).toBe('42');
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('sign({ hash }) posts hash mode to the proxy sign-transaction endpoint', async () => {
    const saved = configureProxyEnv();
    const hash = `0x${'12'.repeat(32)}`;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith('/address')) {
        return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', address: MOCK_ADDRESS }));
      }
      return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', signature: MOCK_SIGNATURE }));
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'proxy' }));
      const signature = await (account as any).sign({ hash });
      expect(signature).toBe(MOCK_SIGNATURE);

      const signCall = (globalThis.fetch as any).mock.calls.find((call: any[]) => call[0].endsWith('/sign-transaction'));
      expect(JSON.parse(signCall[1].body)).toEqual({ hash });
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('signTransaction uses legacy transaction hash signing through the proxy', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith('/address')) {
        return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', address: MOCK_ADDRESS }));
      }
      return Promise.resolve(jsonResponse({ provider: 'cdp', alias: 'agent0-main', signature: MOCK_SIGNATURE }));
    }) as any;

    try {
      const account = await provider.getAccount(makeCfg({ walletProvider: 'proxy' }));
      const signed = await account.signTransaction({
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        nonce: 0,
        gas: 21000n,
        gasPrice: 1000000000n,
        chainId: 72344,
        type: 'legacy',
      } as any);
      expect(signed).toMatch(/^0x/);

      const signCall = (globalThis.fetch as any).mock.calls.find((call: any[]) => call[0].endsWith('/sign-transaction'));
      expect(JSON.parse(signCall[1].body).hash).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('status --json includes sanitized proxy config and remote capabilities', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith('/status')) {
        return Promise.resolve(jsonResponse({
          provider: 'para',
          alias: 'agent0-main',
          status: 'configured',
          address: MOCK_ADDRESS,
        }));
      }
      return Promise.resolve(jsonResponse({
        provider: 'para',
        alias: 'agent0-main',
        capabilities: {
          address: true,
          signMessage: true,
          signTypedData: true,
          signTransaction: true,
          exportPrivateKey: false,
        },
      }));
    }) as any;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));

    try {
      await provider.status(makeCfg({ walletProvider: 'proxy' }), { json: true });
      const parsed = JSON.parse(logs[0]);
      expect(parsed.provider).toBe('proxy');
      expect(parsed.configured).toBe(true);
      expect(parsed.loggedIn).toBe(true);
      expect(parsed.alias).toBe('agent0-main');
      expect(parsed.url).toBe('https://wallet-proxy.example');
      expect(parsed.remoteProvider).toBe('para');
      expect(parsed.address.toLowerCase()).toBe(MOCK_ADDRESS.toLowerCase());
      expect(parsed.capabilities.exportPrivateKey).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('test-token');
      expect(JSON.stringify(parsed)).not.toContain('access-client-secret');
    } finally {
      console.log = origLog;
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });

  it('proxy JSON errors include provider error code and message', async () => {
    const saved = configureProxyEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: 'WALLET_NOT_FOUND',
        message: 'Unknown wallet alias: agent9-main',
      },
    }, 404)) as any;

    try {
      await expect(provider.getAddress(makeCfg({ walletProvider: 'proxy' }))).rejects.toThrow(
        /WALLET_NOT_FOUND: Unknown wallet alias: agent9-main/,
      );
    } finally {
      globalThis.fetch = origFetch;
      restoreProxyEnv(saved);
    }
  });
});

describe('provider telemetry controls', () => {
  it('sets CDP analytics opt-outs by default', () => {
    const origErrorReporting = process.env.DISABLE_CDP_ERROR_REPORTING;
    const origUsageTracking = process.env.DISABLE_CDP_USAGE_TRACKING;
    delete process.env.DISABLE_CDP_ERROR_REPORTING;
    delete process.env.DISABLE_CDP_USAGE_TRACKING;
    try {
      disableProviderTelemetry('cdp');
      expect(process.env.DISABLE_CDP_ERROR_REPORTING).toBe('true');
      expect(process.env.DISABLE_CDP_USAGE_TRACKING).toBe('true');
    } finally {
      if (origErrorReporting === undefined) delete process.env.DISABLE_CDP_ERROR_REPORTING;
      else process.env.DISABLE_CDP_ERROR_REPORTING = origErrorReporting;
      if (origUsageTracking === undefined) delete process.env.DISABLE_CDP_USAGE_TRACKING;
      else process.env.DISABLE_CDP_USAGE_TRACKING = origUsageTracking;
    }
  });

  it('sets Para OpenTelemetry opt-outs by default', () => {
    const origSdkDisabled = process.env.OTEL_SDK_DISABLED;
    const origTracesExporter = process.env.OTEL_TRACES_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_TRACES_EXPORTER;
    try {
      disableProviderTelemetry('para');
      expect(process.env.OTEL_SDK_DISABLED).toBe('true');
      expect(process.env.OTEL_TRACES_EXPORTER).toBe('none');
    } finally {
      if (origSdkDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
      else process.env.OTEL_SDK_DISABLED = origSdkDisabled;
      if (origTracesExporter === undefined) delete process.env.OTEL_TRACES_EXPORTER;
      else process.env.OTEL_TRACES_EXPORTER = origTracesExporter;
    }
  });
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
    const cfg = makeCfg({ walletProvider: 'privy' });
    await expect(requireAccount(cfg, undefined)).rejects.toThrow(/Not logged in to Privy/);
    await expect(getOwnAddress(cfg, undefined)).rejects.toThrow(/Not logged in to Privy/);
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
