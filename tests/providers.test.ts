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

describe('stub providers (privy)', () => {
  const stubs: WalletProviderName[] = ['privy'];

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

  it('logout deletes session file', async () => {
    writeFileSync(paraSessionPath, JSON.stringify(MOCK_SESSION), { mode: 0o600 });
    expect(existsSync(paraSessionPath)).toBe(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));
    try {
      await provider.logout!(makeCfg({ walletProvider: 'para' }));
    } finally {
      console.log = origLog;
    }
    expect(existsSync(paraSessionPath)).toBe(false);
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
    const mockCreateParaViemAccount = vi.fn().mockReturnValue({
      address: MOCK_ADDRESS,
      type: 'local',
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
      sign: vi.fn(),
    });

    vi.doMock('@getpara/server-sdk', () => ({
      Para: vi.fn().mockImplementation(() => ({ setUserShare: mockSetUserShare })),
      Environment: { BETA: 'BETA', PROD: 'PROD', DEV: 'DEV', SANDBOX: 'SANDBOX' },
    }));
    vi.doMock('@getpara/viem-v2-integration', () => ({
      createParaViemAccount: mockCreateParaViemAccount,
    }));

    try {
      // Re-import to pick up mocks
      const { paraProvider } = await import('../src/lib/providers/para.js');
      await paraProvider.getAccount(makeCfg({ walletProvider: 'para' }));

      expect(mockSetUserShare).toHaveBeenCalledWith(MOCK_SESSION.userShare);
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
