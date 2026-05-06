import { Command } from 'commander';
import { confirm, password as promptPassword } from '@inquirer/prompts';
import { readFileSync } from 'node:fs';
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  parseUnits,
  verifyMessage,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { resolveConfig, readPasswordless, writeCachedAddress, writePasswordless } from '../lib/config.js';
import { keystoreExists, loadKeystorePrivateKey, saveKeystore } from '../lib/keystore.js';
import { getOwnAddress, requireAccount } from '../lib/account.js';
import { makePublicClient, makeWalletClient } from '../lib/client.js';
import { coerceArg, parseCastSignature } from '../lib/signature.js';
import { formatUsd, formatUsdShort, jsonStringify } from '../lib/format.js';
import { registerWalletX402 } from './walletX402.js';
import type { GlobalOptions } from '../types.js';

const SBC_DECIMALS = 6;
const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function readMessageArg(arg: string, raw: boolean): string | { raw: Hex } {
  const text = arg === '-' ? readFileSync(0, 'utf8') : arg;
  if (raw) {
    const trimmed = text.trim();
    if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
      throw new Error(`--raw input must be a 0x-prefixed hex string with an even length, got: ${trimmed}`);
    }
    return { raw: trimmed as Hex };
  }
  return text;
}

function normalizePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('Private key must be a 32-byte hex string (64 hex chars).');
  }
  return withPrefix as Hex;
}

async function readNewPassword(envPassword?: string): Promise<string> {
  if (envPassword !== undefined) return envPassword;
  const first = await promptPassword({ message: 'New keystore password:', mask: '*' });
  if (first.length < 8) throw new Error('Password must be at least 8 characters.');
  const second = await promptPassword({ message: 'Confirm password:', mask: '*' });
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

export function registerWallet(program: Command): void {
  const wallet = program.command('wallet').description('Manage the local Radius wallet');

  wallet
    .command('new')
    .description('Create a new keystore at ~/.radius/keystore.json')
    .option('-f, --force', 'overwrite an existing keystore')
    .action(async (subOpts: { force?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (keystoreExists(cfg.keystorePath) && !subOpts.force) {
        throw new Error(`Keystore already exists at ${cfg.keystorePath}. Use --force to overwrite.`);
      }
      const password = await readNewPassword(cfg.password);
      const pk = generatePrivateKey();
      const address = await saveKeystore(cfg.keystorePath, pk, password);
      writeCachedAddress(address);
      writePasswordless(password === '');
      console.log(`Created keystore at ${cfg.keystorePath}`);
      console.log(`Address: ${address}`);
    });

  wallet
    .command('import')
    .description('Import an existing private key into the keystore')
    .argument('<privateKey>', 'hex-encoded private key (with or without 0x)')
    .option('-f, --force', 'overwrite an existing keystore')
    .action(async (privateKeyArg: string, subOpts: { force?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (keystoreExists(cfg.keystorePath) && !subOpts.force) {
        throw new Error(`Keystore already exists at ${cfg.keystorePath}. Use --force to overwrite.`);
      }
      const pk = normalizePrivateKey(privateKeyArg);
      const password = await readNewPassword(cfg.password);
      const address = await saveKeystore(cfg.keystorePath, pk, password);
      writeCachedAddress(address);
      writePasswordless(password === '');
      console.log(`Imported keystore at ${cfg.keystorePath}`);
      console.log(`Address: ${address}`);
    });

  wallet
    .command('address')
    .description('Print the address associated with the local account')
    .action(async (_subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const address = await getOwnAddress(cfg, opts.privateKey);
      console.log(address);
    });

  wallet
    .command('export')
    .description('Decrypt and print the private key (DESTRUCTIVE: prints secret material)')
    .action(async (_subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!opts.privateKey && !keystoreExists(cfg.keystorePath)) {
        throw new Error(
          `No keystore at ${cfg.keystorePath}. Run \`radius-cli wallet new\` or pass --private-key.`,
        );
      }
      const ok = await confirm({
        message: 'Print the raw private key to stdout?',
        default: false,
      });
      if (!ok) return;

      let pk: Hex;
      if (opts.privateKey) {
        pk = normalizePrivateKey(opts.privateKey);
      } else {
        const password = cfg.password
          ?? (readPasswordless() ? '' : await promptPassword({ message: 'Keystore password:', mask: '*' }));
        pk = await loadKeystorePrivateKey(cfg.keystorePath, password);
      }
      const address = privateKeyToAccount(pk).address;
      console.log(`Address: ${address}`);
      console.log(`PrivateKey: ${pk}`);
    });

  wallet
    .command('sign')
    .description('Sign a message with the local account (EIP-191 personal_sign)')
    .argument('<message>', "the message to sign — pass '-' to read from stdin")
    .option('--raw', 'treat the message as raw hex bytes (input must be 0x-prefixed)')
    .action(async (messageArg: string, subOpts: { raw?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const account = await requireAccount(cfg, opts.privateKey);
      const message = readMessageArg(messageArg, !!subOpts.raw);
      const signature = await account.signMessage({ message });
      console.log(signature);
    });

  wallet
    .command('verify')
    .description('Verify an EIP-191 message signature')
    .argument('<message>', "signed message — pass '-' to read from stdin")
    .argument('<signature>', '0x-prefixed signature')
    .option('--raw', 'treat the message as raw hex bytes')
    .option('--address <address>', 'address to verify against (defaults to local account)')
    .action(async (
      messageArg: string,
      signatureArg: string,
      subOpts: { raw?: boolean; address?: string },
      cmd,
    ) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);

      let address: Address;
      if (subOpts.address) {
        if (!isAddress(subOpts.address)) throw new Error(`Not a valid address: ${subOpts.address}`);
        address = subOpts.address as Address;
      } else {
        address = await getOwnAddress(cfg, opts.privateKey);
      }

      const message = readMessageArg(messageArg, !!subOpts.raw);
      const sig = signatureArg.trim() as Hex;
      if (!/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error(`Not a valid 0x signature: ${sig}`);

      const valid = await verifyMessage({ address, message, signature: sig });
      if (opts.json) {
        console.log(jsonStringify({ address, valid }));
        return;
      }
      console.log(valid ? `OK  ${address}` : `FAIL ${address}`);
      if (!valid) process.exitCode = 1;
    });

  wallet
    .command('balance')
    .description('Show RUSD (native) and SBC balances for an address (defaults to own)')
    .argument('[address]', 'address to query (defaults to own)')
    .action(async (addressArg: string | undefined, _subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);

      let address: Address;
      if (addressArg) {
        if (!isAddress(addressArg)) throw new Error(`Not a valid address: ${addressArg}`);
        address = addressArg as Address;
      } else {
        address = await getOwnAddress(cfg, opts.privateKey);
      }

      const client = makePublicClient(cfg);
      const rusdWei = await client.getBalance({ address });
      const rusd = formatEther(rusdWei);

      let sbc = '0';
      let sbcRawWei = 0n;
      let sbcError: string | null = null;
      try {
        sbcRawWei = await client.readContract({
          address: cfg.sbcAddress!,
          abi: ERC20_TRANSFER_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        sbc = formatUnits(sbcRawWei, SBC_DECIMALS);
      } catch (e) {
        sbcError = e instanceof Error ? e.message : String(e);
      }

      const total = Number(rusd) + Number(sbc);

      if (opts.json) {
        console.log(
          jsonStringify({
            address,
            totalUsd: total,
            sbc,
            rusd,
            sbcWei: sbcRawWei.toString(),
            rusdWei: rusdWei.toString(),
            sbcError,
          }),
        );
        return;
      }
      console.log(`Address: ${address}`);
      if (sbcError) {
        console.log(`Balance: $${rusd} ($${formatUsd(rusd)} RUSD; SBC unavailable)`);
      } else {
        console.log(
          `Balance: $${formatUsdShort(total)} ($${formatUsd(sbc)} SBC + $${formatUsd(rusd)} RUSD)`,
        );
      }
    });

  wallet
    .command('send')
    .description(
      [
        'Send tokens. Forms:',
        '  radius-cli wallet send <to> <amount> RUSD       — native value transfer',
        '  radius-cli wallet send <to> <amount> SBC        — ERC-20 transfer of SBC',
        '  radius-cli wallet send <token> "<sig>" [args…]  — call any function',
      ].join('\n  '),
    )
    .argument('[args...]', 'see description for forms')
    .option('--no-wait', 'do not wait for the receipt before returning')
    .option('--gas-limit <units>', 'gas limit for the transaction (skips the eth_estimateGas roundtrip)')
    .action(async (args: string[], subOpts: { wait?: boolean; gasLimit?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const wait = subOpts.wait !== false;
      const gas = parseGasLimit(subOpts.gasLimit);

      // Form A: cast-style — second arg looks like a function signature.
      if (args.length >= 2 && args[1].includes('(')) {
        await sendCastForm(cfg, args, opts, wait, gas);
        return;
      }

      // Form B: symbol form — exactly 3 args, last is RUSD or SBC.
      if (args.length === 3) {
        const [to, amount, rawSymbol] = args;
        const symbol = rawSymbol.toUpperCase();
        if (symbol === 'RUSD') {
          await sendNative(cfg, to, amount, opts, wait, gas);
          return;
        }
        if (symbol === 'SBC') {
          if (!cfg.sbcAddress) {
            throw new Error('SBC contract address is not configured. Set RADIUS_SBC_ADDRESS or pass --sbc.');
          }
          await sendErc20(cfg, cfg.sbcAddress, to, amount, SBC_DECIMALS, opts, wait, gas);
          return;
        }
      }

      const header = args.length === 0
        ? 'wallet send: missing arguments.'
        : `wallet send: could not parse arguments: ${args.join(' ')}`;
      throw new Error(
        [
          header,
          '',
          'Supported forms:',
          '  radius-cli wallet send <to> <amount> RUSD       — native value transfer',
          '  radius-cli wallet send <to> <amount> SBC        — ERC-20 transfer of SBC',
          '  radius-cli wallet send <token> "<sig>" [args…]  — call any function',
        ].join('\n'),
      );
    });

  registerWalletX402(wallet);
}

function parseGasLimit(input: string | undefined): bigint | undefined {
  if (input === undefined) return undefined;
  let value: bigint;
  try {
    value = BigInt(input);
  } catch {
    throw new Error(`--gas-limit must be an integer, got: ${input}`);
  }
  if (value <= 0n) throw new Error(`--gas-limit must be positive, got: ${input}`);
  return value;
}

async function sendNative(
  cfg: ReturnType<typeof resolveConfig>,
  to: string,
  amount: string,
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  if (!isAddress(to)) throw new Error(`Not a valid address: ${to}`);
  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const value = parseEther(amount);
  const gasPrice = await publicClient.getGasPrice();

  const hash = await walletClient.sendTransaction({
    account,
    to: to as Address,
    value,
    gasPrice,
    gas,
    type: 'legacy',
    chain: cfg.chain,
  });
  await reportTx(publicClient, hash, opts, wait);
}

async function sendErc20(
  cfg: ReturnType<typeof resolveConfig>,
  token: Address,
  to: string,
  amount: string,
  decimals: number,
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  if (!isAddress(to)) throw new Error(`Not a valid address: ${to}`);
  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to as Address, parseUnits(amount, decimals)],
  });
  const gasPrice = await publicClient.getGasPrice();

  const hash = await walletClient.sendTransaction({
    account,
    to: token,
    data,
    gasPrice,
    gas,
    type: 'legacy',
    chain: cfg.chain,
  });
  await reportTx(publicClient, hash, opts, wait);
}

async function sendCastForm(
  cfg: ReturnType<typeof resolveConfig>,
  args: string[],
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  const [target, signature, ...callArgs] = args;
  if (!isAddress(target)) throw new Error(`Not a valid address: ${target}`);
  const parsed = parseCastSignature(signature);
  const inputs = parsed.abiItem.inputs ?? [];
  if (callArgs.length !== inputs.length) {
    throw new Error(`Expected ${inputs.length} args for ${signature}, got ${callArgs.length}`);
  }
  const coerced = inputs.map((input, i) => coerceArg(callArgs[i], input.type));
  const data = encodeFunctionData({
    abi: [parsed.abiItem],
    functionName: parsed.abiItem.name,
    args: coerced,
  });

  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const gasPrice = await publicClient.getGasPrice();

  const hash = await walletClient.sendTransaction({
    account,
    to: target as Address,
    data,
    gasPrice,
    gas,
    type: 'legacy',
    chain: cfg.chain,
  });
  await reportTx(publicClient, hash, opts, wait);
}

async function reportTx(
  publicClient: ReturnType<typeof makePublicClient>,
  hash: `0x${string}`,
  opts: GlobalOptions,
  wait: boolean,
): Promise<void> {
  if (!wait) {
    if (opts.json) console.log(jsonStringify({ hash }));
    else console.log(hash);
    return;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (opts.json) {
    console.log(jsonStringify({ hash, receipt }));
  } else {
    console.log(`Hash:        ${hash}`);
    console.log(`Status:      ${receipt.status}`);
    console.log(`Block:       ${receipt.blockNumber.toString()}`);
    console.log(`Gas used:    ${receipt.gasUsed.toString()}`);
  }
}
