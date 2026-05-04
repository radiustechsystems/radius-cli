import { Command } from 'commander';
import { isAddress, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import type { GlobalOptions } from '../types.js';

export function registerStorage(program: Command): void {
  program
    .command('storage')
    .description('Read a storage slot from a contract')
    .argument('<address>', 'contract address')
    .argument('<slot>', 'slot index (decimal or 0x hex)')
    .action(async (address: string, slot: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(address)) throw new Error(`Not a valid address: ${address}`);

      const slotHex = slot.startsWith('0x')
        ? (slot as `0x${string}`)
        : (`0x${BigInt(slot).toString(16)}` as `0x${string}`);

      const client = makePublicClient(cfg);
      const value = await client.getStorageAt({ address: address as Address, slot: slotHex });
      console.log(value ?? '0x');
    });
}
