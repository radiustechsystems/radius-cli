#!/usr/bin/env node
import { Command } from 'commander';
import { registerCall } from './commands/call.js';
import { registerCode } from './commands/code.js';
import { registerNonce } from './commands/nonce.js';
import { registerReceipt } from './commands/receipt.js';
import { registerStorage } from './commands/storage.js';
import { registerTx } from './commands/tx.js';
import { registerWallet } from './commands/wallet.js';

const program = new Command();

program
  .name('radius-cli')
  .description('CLI wallet for the Radius network — like cast, with a built-in account')
  .version('0.1.0')
  .option('--network <name>', "'mainnet' or 'testnet' (default: mainnet)")
  .option('--rpc-url <url>', 'override the RPC URL')
  .option('--private-key <hex>', 'sign with this key instead of the local keystore')
  .option('--sbc <address>', 'override the SBC token contract address')
  .option('--rusd <address>', 'override the RUSD ERC-20 contract address')
  .option('--wallet <provider>', 'wallet provider: keystore, cdp, para, or privy (default: keystore)')
  .option('--json', 'machine-readable JSON output');

registerWallet(program);
registerCall(program);
registerTx(program);
registerReceipt(program);
registerStorage(program);
registerCode(program);
registerNonce(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    msg = typeof obj['message'] === 'string' ? obj['message'] : JSON.stringify(err, null, 2);
  } else {
    msg = String(err);
  }
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
