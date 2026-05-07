import { Command } from 'commander';
import { formatEther, type Hash } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

function assertHash(s: string): asserts s is Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`Not a valid 32-byte hash: ${s}`);
  }
}

export function registerTx(program: Command): void {
  program
    .command('tx')
    .description('Get a transaction by hash')
    .argument('<hash>', 'transaction hash')
    .action(async (hash: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      assertHash(hash);
      const client = makePublicClient(cfg);
      const tx = await client.getTransaction({ hash });
      if (opts.json) {
        console.log(jsonStringify(tx));
        return;
      }
      console.log(`Hash:        ${tx.hash}`);
      console.log(`Block:       ${tx.blockNumber?.toString() ?? '(pending)'}`);
      console.log(`From:        ${tx.from}`);
      console.log(`To:          ${tx.to ?? '(contract creation)'}`);
      console.log(`Value:       ${formatEther(tx.value)} RUSD`);
      console.log(`Nonce:       ${tx.nonce}`);
      console.log(`Gas:         ${tx.gas.toString()}`);
      if (tx.gasPrice !== undefined) console.log(`Gas price:   ${tx.gasPrice.toString()}`);
      console.log(`Input:       ${tx.input}`);
    });
}
