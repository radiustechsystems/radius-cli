import type { Command } from 'commander';
import { isAddress, type Address } from 'viem';
import {
  createFaucetClient,
  FaucetError,
  type FaucetClient,
  type FaucetDrip,
  type FaucetSigner,
  type FaucetStatus,
} from 'radius-sdk/faucet';
import { resolveConfig } from '../lib/config.js';
import { deferredAccount, getOwnAddress } from '../lib/account.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions, ResolvedConfig } from '../types.js';

/** Options shared by `wallet faucet drip` and `wallet faucet status`. */
interface FaucetOptions {
  faucetUrl?: string;
  token?: string;
}

interface DripOptions extends FaucetOptions {
  signature?: string;
}

const SIGNATURE_MODES = ['auto', 'always', 'never'] as const;
type SignatureMode = (typeof SIGNATURE_MODES)[number];

/** What `wallet faucet drip` prints (`--json` prints exactly this object). */
export interface DripOutput {
  faucetUrl: string;
  address: string;
  token: string;
  amount: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  /** The RUSD gas drip that accompanied the token transfer, where the faucet does one. */
  native: { token: string; amount: string; txHash: string | null } | null;
  /** ISO-8601 time at which this address may drip again, when the faucet says. */
  nextDripAt: string | null;
}

/** What `wallet faucet status` prints (`--json` prints exactly this object). */
export interface StatusOutput {
  faucetUrl: string;
  address: string;
  token: string;
  rateLimited: boolean;
  /** Milliseconds until the next drip is allowed; null unless rate limited. */
  retryAfterMs: number | null;
  /** Requests left in the current window; null when the faucet reports no limit. */
  remainingRequests: number | null;
  dripAmount: string | null;
  nativeDripAmount: string | null;
  unlimited: boolean;
}

export function registerWalletFaucet(wallet: Command): void {
  const faucet = wallet
    .command('faucet')
    .description(
      [
        'Request test funds from the Radius faucet for the configured network.',
        '',
        '  radius-cli --network testnet wallet faucet             # drip into the local wallet',
        '  radius-cli --network testnet wallet faucet 0xOther     # drip into another address',
        '  radius-cli --network testnet wallet faucet status      # rate-limit state and drip amounts',
      ].join('\n'),
    );

  faucet
    .command('drip', { isDefault: true })
    .alias('fund')
    .description('Drip from the faucet into an address (defaults to the local wallet)')
    .argument('[address]', 'recipient (defaults to the local wallet)')
    .option('--faucet-url <url>', 'faucet base URL (default: the network\'s, or RADIUS_FAUCET_URL)')
    .option('--token <symbol>', 'token to request (default: SBC)')
    .option(
      '--signature <mode>',
      `${SIGNATURE_MODES.join('|')}: sign the faucet's EIP-191 challenge only if asked (auto), always, or never (default: auto)`,
    )
    .action(async (addressArg: string | undefined, subOpts: DripOptions, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const mode = parseSignatureMode(subOpts.signature);
      const client = makeFaucetClient(cfg, subOpts);

      // Own address: the keystore is unlocked only if the faucet actually asks for a signature.
      // Someone else's address: nothing to sign with, so a signature demand is an error.
      const own = await getOwnAddress(cfg, opts.privateKey);
      const address = parseRecipient(addressArg) ?? own;
      const signer = address.toLowerCase() === own.toLowerCase()
        ? await deferredAccount(cfg, opts.privateKey)
        : undefined;

      const out = await withFaucetErrors(() => runDrip(client, address, signer, mode));
      if (opts.json) {
        console.log(jsonStringify(out));
        return;
      }
      for (const line of formatDrip(out)) console.log(line);
    });

  faucet
    .command('status')
    .description('Show rate-limit state and drip amounts for an address (defaults to the local wallet)')
    .argument('[address]', 'address to query (defaults to the local wallet)')
    .option('--faucet-url <url>', 'faucet base URL (default: the network\'s, or RADIUS_FAUCET_URL)')
    .option('--token <symbol>', 'token to query (default: SBC)')
    .action(async (addressArg: string | undefined, subOpts: FaucetOptions, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const client = makeFaucetClient(cfg, subOpts);
      const address = parseRecipient(addressArg) ?? (await getOwnAddress(cfg, opts.privateKey));

      const out = await withFaucetErrors(() => runStatus(client, address));
      if (opts.json) {
        console.log(jsonStringify(out));
        return;
      }
      for (const line of formatStatus(out)) console.log(line);
    });
}

/** The faucet client for the configured network; `--faucet-url` > RADIUS_FAUCET_URL > config.json > network default. */
export function makeFaucetClient(cfg: Pick<ResolvedConfig, 'network' | 'faucetUrl'>, subOpts: FaucetOptions): FaucetClient {
  const url = subOpts.faucetUrl ?? cfg.faucetUrl;
  return createFaucetClient({ network: cfg.network, url, token: subOpts.token });
}

export function parseSignatureMode(input: string | undefined): SignatureMode {
  if (input === undefined) return 'auto';
  if ((SIGNATURE_MODES as readonly string[]).includes(input)) return input as SignatureMode;
  throw new Error(`--signature must be one of ${SIGNATURE_MODES.join(', ')} (got '${input}')`);
}

function parseRecipient(input: string | undefined): Address | undefined {
  if (input === undefined) return undefined;
  if (!isAddress(input)) throw new Error(`Not a valid address: ${input}`);
  return input;
}

export async function runDrip(
  client: FaucetClient,
  address: Address,
  signer: FaucetSigner | undefined,
  signature: SignatureMode,
): Promise<DripOutput> {
  const drip = await client.fund(address, { signer, signature });
  return dripOutput(client, drip);
}

export async function runStatus(client: FaucetClient, address: Address): Promise<StatusOutput> {
  const status = await client.status(address);
  return statusOutput(client, status);
}

export function dripOutput(client: Pick<FaucetClient, 'url'>, drip: FaucetDrip): DripOutput {
  return {
    faucetUrl: client.url,
    address: drip.address,
    token: drip.token,
    amount: drip.amount ?? null,
    txHash: drip.txHash ?? null,
    explorerUrl: drip.explorerUrl ?? null,
    native: drip.native ? { token: drip.native.token, amount: drip.native.amount, txHash: drip.native.txHash ?? null } : null,
    nextDripAt: drip.nextDripAt !== undefined ? new Date(drip.nextDripAt * 1000).toISOString() : null,
  };
}

export function statusOutput(client: Pick<FaucetClient, 'url'>, status: FaucetStatus): StatusOutput {
  return {
    faucetUrl: client.url,
    address: status.address,
    token: status.token,
    rateLimited: status.rateLimited,
    retryAfterMs: status.retryAfterMs ?? null,
    remainingRequests: status.remainingRequests ?? null,
    dripAmount: status.dripAmount ?? null,
    nativeDripAmount: status.nativeDripAmount ?? null,
    unlimited: status.unlimited === true,
  };
}

export function formatDrip(out: DripOutput): string[] {
  const lines = [
    `Faucet:    ${out.faucetUrl}`,
    `Address:   ${out.address}`,
    `Dripped:   ${out.amount ?? '?'} ${out.token}`,
  ];
  if (out.txHash) lines.push(`Tx:        ${out.explorerUrl ?? out.txHash}`);
  if (out.native) {
    const tx = out.native.txHash ? ` (tx ${out.native.txHash})` : '';
    lines.push(`Gas:       ${out.native.amount} ${out.native.token}${tx}`);
  }
  if (out.nextDripAt) lines.push(`Next drip: ${out.nextDripAt}`);
  return lines;
}

export function formatStatus(out: StatusOutput): string[] {
  const gas = out.nativeDripAmount ? ` + ${out.nativeDripAmount} RUSD for gas` : '';
  const lines = [
    `Faucet:    ${out.faucetUrl}`,
    `Address:   ${out.address}`,
    `Drip:      ${out.dripAmount ?? '?'} ${out.token}${gas}`,
  ];
  if (out.rateLimited) {
    lines.push(`Status:    rate limited, retry in ${formatSeconds(out.retryAfterMs)}`);
  } else if (out.unlimited) {
    lines.push('Status:    ready (no rate limit)');
  } else {
    const left = out.remainingRequests !== null ? `${out.remainingRequests} request${out.remainingRequests === 1 ? '' : 's'} left` : 'requests left unknown';
    lines.push(`Status:    ready, ${left}`);
  }
  return lines;
}

function formatSeconds(ms: number | null): string {
  if (ms === null) return 'a while';
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s <= 5400) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

/**
 * Exit code for a faucet failure: 2 when the request was well-formed but the faucet declined for now
 * (rate limit, empty, needs a signature we do not hold), 1 for everything else.
 */
export function faucetExitCode(e: FaucetError): 1 | 2 {
  switch (e.faucetCode) {
    case 'rate_limited':
    case 'faucet_empty':
    case 'signer_required':
    case 'signature_required':
      return 2;
    default:
      return 1;
  }
}

/** Faucet API errors go to stderr as `faucet: …` with their code; anything else propagates to the top-level handler. */
async function withFaucetErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof FaucetError)) throw e;
    process.stderr.write(`faucet: ${e.message}\n`);
    if (e.faucetCode === 'signer_required') {
      process.stderr.write('faucet: this faucet needs the recipient to sign; drip into the local wallet (no address argument) or pass its key with --private-key.\n');
    }
    if (e.faucetCode === 'receipt_timeout' || e.faucetCode === 'transaction_reverted' || e.faucetCode === 'native_drip_failed') {
      const tx = e.errorDetails?.tx_hash;
      if (typeof tx === 'string') process.stderr.write(`faucet: transaction ${tx}\n`);
    }
    process.exit(faucetExitCode(e));
  }
}
