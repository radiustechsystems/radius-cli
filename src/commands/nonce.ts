import { Command } from 'commander';
import { isAddress, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import type { GlobalOptions } from '../types.js';

export function registerNonce(program: Command): void {
  program
    .command('nonce')
    .description('Get the transaction count (nonce) for an address')
    .argument('<address>', 'address')
    .action(async (address: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(address)) throw new Error(`Not a valid address: ${address}`);
      const client = makePublicClient(cfg);
      const nonce = await client.getTransactionCount({ address: address as Address });
      console.log(nonce.toString());
    });
}
