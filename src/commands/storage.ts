import { Command } from 'commander';
import { isAddress, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

export function registerStorage(program: Command): void {
  program
    .command('storage')
    .description('Read a storage slot from a contract')
    .argument('<address>', 'contract address')
    .argument('<slot>', 'slot index (decimal or 0x hex)')
    .action(async (addressArg: string, slot: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(addressArg)) throw new Error(`Not a valid address: ${addressArg}`);
      const address = addressArg as Address;

      const slotHex = slot.startsWith('0x')
        ? (slot as `0x${string}`)
        : (`0x${BigInt(slot).toString(16)}` as `0x${string}`);

      const client = makePublicClient(cfg);
      const value = (await client.getStorageAt({ address, slot: slotHex })) ?? '0x';
      if (opts.json) {
        console.log(jsonStringify({ address, slot: slotHex, value }));
        return;
      }
      console.log(value);
    });
}
