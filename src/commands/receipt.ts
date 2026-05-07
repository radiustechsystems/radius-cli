import { Command } from 'commander';
import type { Hash } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

function assertHash(s: string): asserts s is Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`Not a valid 32-byte hash: ${s}`);
  }
}

export function registerReceipt(program: Command): void {
  program
    .command('receipt')
    .description('Get a transaction receipt by hash')
    .argument('<hash>', 'transaction hash')
    .action(async (hash: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      assertHash(hash);
      const client = makePublicClient(cfg);
      const receipt = await client.getTransactionReceipt({ hash });
      if (opts.json) {
        console.log(jsonStringify(receipt));
        return;
      }
      console.log(`Hash:             ${receipt.transactionHash}`);
      console.log(`Status:           ${receipt.status}`);
      console.log(`Block:            ${receipt.blockNumber.toString()}`);
      console.log(`From:             ${receipt.from}`);
      console.log(`To:               ${receipt.to ?? '(contract creation)'}`);
      if (receipt.contractAddress) {
        console.log(`Contract:         ${receipt.contractAddress}`);
      }
      console.log(`Gas used:         ${receipt.gasUsed.toString()}`);
      console.log(`Cumulative gas:   ${receipt.cumulativeGasUsed.toString()}`);
      console.log(`Logs:             ${receipt.logs.length}`);
    });
}
