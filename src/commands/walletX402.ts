import type { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { formatUnits, parseUnits, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { requireAccount } from '../lib/account.js';
import { makePublicClient } from '../lib/client.js';
import { jsonStringify } from '../lib/format.js';
import {
  decodeBodyAsUtf8,
  isSupportedVerb,
  looksLikeJson,
  parseHeaderArgs,
  readBodyArg,
  runRequest,
  sameOrigin,
  SUPPORTED_VERBS,
  type HttpResponse,
  type HttpVerb,
} from '../lib/x402/http.js';
import {
  decodePaymentResponse,
  encodePaymentHeader,
  networkIdForChain,
  parseChallenge,
  pickAccept,
  type AcceptEntry,
  type PaymentResponseBody,
} from '../lib/x402/protocol.js';
import {
  makeAuthorization,
  readAssetInfo,
  readBalance,
  signTransferAuthorization,
} from '../lib/x402/eip3009.js';
import type { GlobalOptions } from '../types.js';

interface SubOptions {
  header?: string[];
  data?: string;
  x402Threshold?: string;
  yes?: boolean;
  include?: boolean;
}

interface PaymentSummary {
  paid: boolean;
  asset: Address;
  assetSymbol: string | null;
  amount: string;
  amountWei: string;
  payTo: Address;
  txHash?: string;
  payer?: string;
}

export function registerWalletX402(wallet: Command): void {
  wallet
    .command('x402')
    .description(
      [
        'Make an HTTP request and pay an x402 challenge if the server responds with 402.',
        '',
        '  radius-cli wallet x402 get https://example.com/resource',
        '  radius-cli wallet x402 post https://api.example.com/x -d \'{"a":1}\'',
        '  radius-cli wallet x402 get https://example.com/r --x402-threshold 0.05',
      ].join('\n'),
    )
    .argument('<verb>', `HTTP verb (${SUPPORTED_VERBS.join(', ')})`)
    .argument('<url>', 'request URL')
    .option('-H, --header <h...>', "request header, repeatable: 'Key: Value'")
    .option('-d, --data <body>', "request body (literal, '@path' for file, '-' for stdin)")
    .option(
      '--x402-threshold <decimal>',
      "auto-pay if the offered fee ≤ this amount in the asset's display units",
    )
    .option('-y, --yes', 'auto-confirm payment regardless of amount')
    .option('--include', 'write response status and headers to stderr')
    .action(async (verbArg: string, url: string, subOpts: SubOptions, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runX402(verbArg, url, subOpts, opts);
    });
}

async function runX402(
  verbArg: string,
  url: string,
  subOpts: SubOptions,
  opts: GlobalOptions,
): Promise<void> {
  const verb = verbArg.toLowerCase();
  if (!isSupportedVerb(verb)) {
    process.stderr.write(`x402: unsupported verb '${verbArg}' (use one of ${SUPPORTED_VERBS.join(', ')})\n`);
    process.exit(2);
  }

  const reqHeaders = parseHeaderArgs(subOpts.header);
  const body = readBodyArg(subOpts.data);
  if (body && !reqHeaders.has('content-type') && looksLikeJson(body)) {
    reqHeaders.set('content-type', 'application/json');
  }

  const initial = await runRequest(verb as HttpVerb, url, { headers: reqHeaders, body });
  if (initial.status !== 402) {
    emit(initial, null, !!opts.json, !!subOpts.include);
    process.exit(initial.status >= 400 ? 1 : 0);
  }

  const cfg = resolveConfig(opts);
  let challenge;
  try {
    const text = decodeBodyAsUtf8(initial.body) ?? '';
    challenge = parseChallenge(JSON.parse(text));
  } catch (e) {
    process.stderr.write(
      `x402: server returned 402 but the body is not a valid challenge: ${(e as Error).message}\n`,
    );
    process.stderr.write(safeBodyPreview(initial.body));
    process.exit(2);
  }

  const accept = pickAccept(challenge.accepts, cfg.chain.id);
  if (!accept) {
    const offered = challenge.accepts
      .map((a) => `${a.scheme}@${a.network} (${a.asset})`)
      .join(', ');
    process.stderr.write(
      `x402: no compatible payment option. Wanted scheme=exact network=${networkIdForChain(cfg.chain.id)}; server offered: ${offered}\n`,
    );
    process.exit(1);
  }

  const account = await requireAccount(cfg, opts.privateKey);
  const client = makePublicClient(cfg);

  let asset;
  try {
    asset = await readAssetInfo(client, accept.asset, accept.extra);
  } catch (e) {
    process.stderr.write(
      `x402: failed to read asset metadata at ${accept.asset}: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  const balance = await readBalance(client, accept.asset, account.address);
  const amountStr = formatUnits(accept.maxAmountRequired, asset.decimals);
  const balanceStr = formatUnits(balance, asset.decimals);
  const symbol = asset.symbol ?? accept.asset;

  if (balance < accept.maxAmountRequired) {
    process.stderr.write(
      `x402: insufficient balance. Need ${amountStr} ${symbol}, have ${balanceStr} ${symbol}.\n`,
    );
    process.exit(1);
  }

  const decided = await decideAutoPay(subOpts, accept, asset.decimals);
  if (decided === 'refuse-no-tty') {
    writeChallengeSummary(accept, asset.decimals, asset.symbol, balanceStr);
    process.exit(2);
  }
  if (decided === 'prompt') {
    const proceed = await confirm({
      message: `Pay ${amountStr} ${symbol} to ${accept.payTo}? (balance: ${balanceStr} ${symbol})`,
      default: false,
    });
    if (!proceed) {
      process.stderr.write('x402: payment declined.\n');
      process.exit(1);
    }
  }

  const authorization = makeAuthorization({
    from: account.address,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
  });

  let signature;
  try {
    signature = await signTransferAuthorization(account, {
      asset: accept.asset,
      chainId: cfg.chain.id,
      name: asset.name,
      version: asset.version,
      authorization,
    });
  } catch (e) {
    process.stderr.write(
      `x402: failed to sign EIP-3009 authorization (asset may not support transferWithAuthorization): ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  const paymentHeader = encodePaymentHeader({
    x402Version: challenge.x402Version,
    scheme: accept.scheme,
    network: accept.network,
    payload: { signature, authorization },
  });

  const retryHeaders = new Headers(reqHeaders);
  retryHeaders.set('x-payment', paymentHeader);

  const retry = await runRequest(verb as HttpVerb, url, {
    headers: retryHeaders,
    body,
    redirect: 'manual',
  });

  if (retry.status >= 300 && retry.status < 400) {
    const loc = retry.headers.get('location');
    if (!loc || !sameOrigin(url, new URL(loc, url).toString())) {
      process.stderr.write(
        'x402: server redirected the paid request cross-origin; refusing to replay X-PAYMENT.\n',
      );
      process.exit(1);
    }
  }

  let paymentResponse: PaymentResponseBody | null = null;
  const xpr = retry.headers.get('x-payment-response');
  if (xpr) {
    try { paymentResponse = decodePaymentResponse(xpr); } catch { /* ignore malformed */ }
  }

  const summary: PaymentSummary = {
    paid: retry.status >= 200 && retry.status < 300,
    asset: accept.asset,
    assetSymbol: asset.symbol,
    amount: amountStr,
    amountWei: accept.maxAmountRequired.toString(),
    payTo: accept.payTo,
    txHash: paymentResponse?.transaction,
    payer: paymentResponse?.payer ?? account.address,
  };

  if (retry.status === 402) {
    process.stderr.write('x402: server still returned 402 after payment.\n');
    if (paymentResponse?.errorReason) {
      process.stderr.write(`reason: ${paymentResponse.errorReason}\n`);
    }
    process.stderr.write(safeBodyPreview(retry.body));
    if (opts.json) {
      console.log(jsonStringify(envelope(retry, { ...summary, paid: false })));
    }
    process.exit(1);
  }

  emit(retry, summary, !!opts.json, !!subOpts.include);
  process.exit(retry.status >= 400 ? 1 : 0);
}

type Decision = 'auto-pay' | 'prompt' | 'refuse-no-tty';

async function decideAutoPay(
  subOpts: SubOptions,
  accept: AcceptEntry,
  decimals: number,
): Promise<Decision> {
  if (subOpts.yes) return 'auto-pay';
  if (subOpts.x402Threshold !== undefined) {
    let limit: bigint;
    try {
      limit = parseUnits(subOpts.x402Threshold, decimals);
    } catch {
      throw new Error(`--x402-threshold must be a decimal number, got: ${subOpts.x402Threshold}`);
    }
    if (limit >= accept.maxAmountRequired) return 'auto-pay';
  }
  if (process.stdin.isTTY) return 'prompt';
  return 'refuse-no-tty';
}

function writeChallengeSummary(
  accept: AcceptEntry,
  decimals: number,
  symbol: string | null,
  balanceStr: string,
): void {
  const amount = formatUnits(accept.maxAmountRequired, decimals);
  const tag = symbol ?? accept.asset;
  process.stderr.write(
    [
      `x402: payment required (${amount} ${tag} to ${accept.payTo}).`,
      `      balance: ${balanceStr} ${tag}`,
      `      pass --x402-threshold ${amount} (or higher) to auto-pay, or --yes to confirm.`,
      '',
    ].join('\n'),
  );
}

function emit(res: HttpResponse, payment: PaymentSummary | null, json: boolean, include: boolean): void {
  if (json) {
    console.log(jsonStringify(envelope(res, payment)));
    return;
  }
  if (include) {
    process.stderr.write(`HTTP ${res.status}\n`);
    res.headers.forEach((v, k) => { process.stderr.write(`${k}: ${v}\n`); });
    process.stderr.write('\n');
  }
  if (payment?.paid && payment.txHash) {
    process.stderr.write(`x402: paid ${payment.amount} ${payment.assetSymbol ?? payment.asset} (tx ${payment.txHash})\n`);
  } else if (payment?.paid) {
    process.stderr.write(`x402: paid ${payment.amount} ${payment.assetSymbol ?? payment.asset}\n`);
  }
  process.stdout.write(res.body);
}

function envelope(res: HttpResponse, payment: PaymentSummary | null): Record<string, unknown> {
  const decoded = decodeBodyAsUtf8(res.body);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return {
    status: res.status,
    headers,
    body: decoded ?? Buffer.from(res.body).toString('base64'),
    bodyEncoding: decoded === null ? 'base64' : 'utf8',
    payment,
  };
}

function safeBodyPreview(body: Uint8Array): string {
  const s = decodeBodyAsUtf8(body) ?? '';
  const trimmed = s.length > 1024 ? s.slice(0, 1024) + '\n…(truncated)' : s;
  return trimmed.endsWith('\n') ? trimmed : trimmed + '\n';
}
