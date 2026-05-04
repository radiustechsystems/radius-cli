import { Command } from 'commander';
import { decodeFunctionResult, encodeFunctionData, isAddress, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { coerceArg, parseCastSignature } from '../lib/signature.js';
import { jsonStringify, printResult } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

export function registerCall(program: Command): void {
  program
    .command('call')
    .description('Call a contract function (eth_call)')
    .argument('<address>', 'contract address (0x…)')
    .argument('<signature>', 'function signature, e.g. "balanceOf(address)(uint256)"')
    .argument('[args...]', 'function arguments')
    .action(async (address: string, signature: string, args: string[], _opts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(address)) throw new Error(`Not a valid address: ${address}`);

      const parsed = parseCastSignature(signature);
      const inputs = parsed.abiItem.inputs ?? [];
      if (args.length !== inputs.length) {
        throw new Error(`Expected ${inputs.length} args for ${signature}, got ${args.length}`);
      }
      const coerced = inputs.map((input, i) => coerceArg(args[i], input.type));
      const data = encodeFunctionData({ abi: [parsed.abiItem], functionName: parsed.abiItem.name, args: coerced });

      const client = makePublicClient(cfg);
      const { data: returnData } = await client.call({ to: address as Address, data });

      if (!returnData || !parsed.isView) {
        printResult(returnData ?? '0x', !!opts.json);
        return;
      }

      const decoded = decodeFunctionResult({
        abi: [parsed.abiItem],
        functionName: parsed.abiItem.name,
        data: returnData,
      });

      if (opts.json) {
        console.log(jsonStringify(decoded));
        return;
      }
      // viem returns a single value for one return, an array for multiple.
      if (Array.isArray(decoded) && parsed.returnTypes.length > 1) {
        for (const v of decoded) printResult(v, false);
      } else {
        printResult(decoded, false);
      }
    });
}
