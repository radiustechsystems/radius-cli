import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { radiusMainnetChain, radiusTestnetChain, SBC } from 'radius-sdk';
import { networkConfig, registerNetwork } from '../src/commands/network.js';
import type { ResolvedConfig } from '../src/types.js';

const cfg = (over: Partial<ResolvedConfig>): ResolvedConfig => ({
  network: 'testnet',
  chain: radiusTestnetChain,
  rpcUrl: radiusTestnetChain.rpcUrls.default.http[0],
  sbcAddress: SBC.address,
  keystorePath: '/nonexistent/keystore.json',
  ...over,
});

describe('network', () => {
  it('reports the testnet preset from radius-sdk', () => {
    expect(networkConfig(cfg({}))).toEqual({
      network: 'testnet',
      preset: 'radius-testnet',
      chainName: 'Radius Test Network',
      chainId: 72344,
      caip2: 'eip155:72344',
      testnet: true,
      rpcUrl: 'https://rpc.testnet.radiustech.xyz',
      explorerUrl: 'https://testnet.radiustech.xyz',
      facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz',
      faucetUrl: 'https://testnet.radiustech.xyz/api/v1/faucet',
      nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
      sbc: { address: SBC.address, symbol: 'SBC', decimals: 6, name: 'Stable Coin', version: '1' },
      rusdAddress: null,
    });
  });

  it('reports mainnet', () => {
    const r = networkConfig(cfg({ network: 'mainnet', chain: radiusMainnetChain, rpcUrl: 'https://rpc.radiustech.xyz' }));
    expect(r).toMatchObject({
      preset: 'radius',
      chainId: 723487,
      caip2: 'eip155:723487',
      testnet: false,
      rpcUrl: 'https://rpc.radiustech.xyz',
      explorerUrl: 'https://network.radiustech.xyz',
      facilitatorUrl: 'https://facilitator.radiustech.xyz',
      faucetUrl: 'https://network.radiustech.xyz/api/v1/faucet',
    });
  });

  it('applies the --rpc-url, --sbc and --rusd overrides', () => {
    const sbc = '0x000000000000000000000000000000000000bEEF';
    const rusd = '0x000000000000000000000000000000000000dEaD';
    const r = networkConfig(cfg({ rpcUrl: 'https://rpc.example/', sbcAddress: sbc, rusdAddress: rusd }));
    expect(r.rpcUrl).toBe('https://rpc.example');
    expect(r.sbc).toMatchObject({ address: sbc, decimals: 6 });
    expect(r.rusdAddress).toBe(rusd);
  });

  it('prints JSON with --json', async () => {
    const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--sbc <address>').option('--rusd <address>').option('--json');
    registerNetwork(program);
    let out = '';
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
    try {
      await program.parseAsync(['node', 'radius-cli', '--network', 'testnet', '--rpc-url', 'https://rpc.example', '--json', 'network']);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(out)).toMatchObject({ network: 'testnet', chainId: 72344, rpcUrl: 'https://rpc.example', sbc: { decimals: 6 } });
  });
});
