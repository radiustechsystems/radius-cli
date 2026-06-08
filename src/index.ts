#!/usr/bin/env node
import { Command } from 'commander';
import { registerCall } from './commands/call.js';
import { registerCode } from './commands/code.js';
import { registerNonce } from './commands/nonce.js';
import { registerReceipt } from './commands/receipt.js';
import { registerStorage } from './commands/storage.js';
import { registerTx } from './commands/tx.js';
import { registerWallet } from './commands/wallet.js';
import { readWalletProvider } from './lib/config.js';
import {
  CliError,
  EXIT_GENERAL_ERROR,
  EXIT_AUTH,
  EXIT_BALANCE,
  EXIT_CONFIG,
  EXIT_NETWORK,
} from './lib/exitCodes.js';

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
  .option('--wallet <provider>', 'wallet provider: keystore, cdp, para, privy, or proxy (default: keystore)')
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
  const selectedWallet = program.opts().wallet ?? process.env.RADIUS_WALLET ?? readWalletProvider();
  if (selectedWallet === 'para') {
    // Para's SDK can leave transport/telemetry handles alive after CLI work is done.
    process.exit(0);
  }
}

function inferExitCode(msg: string): number {
  const lower = msg.toLowerCase();
  if (lower.includes('not logged in') || lower.includes('unauthorized') || lower.includes('not configured'))
    return EXIT_AUTH;
  if (lower.includes('not configured') || lower.includes('missing') || lower.includes('must be one of'))
    return EXIT_CONFIG;
  if (lower.includes('insufficient balance') || lower.includes('transfer amount exceeds balance'))
    return EXIT_BALANCE;
  if (lower.includes('rpc request failed') || lower.includes('exec failed') || lower.includes('execution reverted'))
    return EXIT_NETWORK;
  return EXIT_GENERAL_ERROR;
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
  const exitCode = err instanceof CliError ? err.exitCode : inferExitCode(msg);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(exitCode);
});
