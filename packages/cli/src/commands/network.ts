import { Command } from 'commander';
import { resolveNetwork } from 'radius-sdk';
import { resolveConfig } from '../lib/config.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions, ResolvedConfig } from '../types.js';

export interface NetworkConfigReport {
  /** CLI network name: 'mainnet' or 'testnet'. */
  network: string;
  /** radius-sdk preset id, e.g. 'radius-testnet'. */
  preset: string;
  chainName: string;
  chainId: number;
  /** CAIP-2 id, as on the x402 wire. */
  caip2: string;
  testnet: boolean;
  rpcUrl: string;
  explorerUrl: string | null;
  facilitatorUrl: string | null;
  faucetUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** The payment asset, with its EIP-712 domain name and version. */
  sbc: { address: string; symbol: string; decimals: number; name: string; version: string };
  rusdAddress: string | null;
}

/**
 * The selected network as radius-sdk defines it, with the CLI's `--rpc-url` / `--sbc` overrides
 * (and their environment and config-file equivalents) applied. Reads no chain state.
 */
export function networkConfig(cfg: ResolvedConfig): NetworkConfigReport {
  const n = resolveNetwork(cfg.network, { rpcUrl: cfg.rpcUrl, asset: cfg.sbcAddress ? { address: cfg.sbcAddress } : undefined });
  return {
    network: cfg.network,
    preset: n.name,
    chainName: n.chain.name,
    chainId: n.chainId,
    caip2: n.network,
    testnet: n.testnet,
    rpcUrl: n.rpcUrl,
    explorerUrl: n.explorerUrl ?? null,
    facilitatorUrl: n.facilitatorUrl ?? null,
    faucetUrl: n.faucetUrl ?? null,
    nativeCurrency: { ...n.chain.nativeCurrency },
    sbc: { ...n.asset },
    rusdAddress: cfg.rusdAddress ?? null,
  };
}

export function registerNetwork(program: Command): void {
  program
    .command('network')
    .description('Print the selected network\'s config: chain id, RPC, explorer, facilitator, faucet and SBC token')
    .action((_opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const report = networkConfig(resolveConfig(opts));
      if (opts.json) {
        console.log(jsonStringify(report));
        return;
      }
      const rows: [string, string][] = [
        ['Network', `${report.network} (${report.preset})`],
        ['Chain', `${report.chainName}`],
        ['Chain ID', `${report.chainId} (${report.caip2})`],
        ['RPC URL', report.rpcUrl],
        ['Explorer', report.explorerUrl ?? '-'],
        ['Facilitator', report.facilitatorUrl ?? '-'],
        ['Faucet', report.faucetUrl ?? '-'],
        ['Native', `${report.nativeCurrency.symbol} (${report.nativeCurrency.decimals} decimals)`],
        ['SBC', `${report.sbc.address} (${report.sbc.decimals} decimals)`],
      ];
      if (report.rusdAddress) rows.push(['RUSD ERC-20', report.rusdAddress]);
      for (const [label, value] of rows) console.log(`${(label + ':').padEnd(13)}${value}`);
    });
}
