import { Command } from 'commander';
import { isAddress, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

export function registerCode(program: Command): void {
  program
    .command('code')
    .description('Get the bytecode at an address')
    .argument('<address>', 'address')
    .action(async (addressArg: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(addressArg)) throw new Error(`Not a valid address: ${addressArg}`);
      const address = addressArg as Address;
      const client = makePublicClient(cfg);
      const code = (await client.getCode({ address })) ?? '0x';
      if (opts.json) {
        console.log(jsonStringify({ address, code }));
        return;
      }
      console.log(code);
    });
}
