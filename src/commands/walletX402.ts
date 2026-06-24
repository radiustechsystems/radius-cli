import type { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { encodeFunctionData, formatUnits, maxUint256, parseUnits, type Address } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { requireAccount } from '../lib/account.js';
import { makePublicClient, makeWalletClient } from '../lib/client.js';
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
  networkIdForChain,
  parseChallenge,
  V1_PAYMENT_RESPONSE_HEADER,
  V2_PAYMENT_REQUIRED_HEADER,
  V2_PAYMENT_RESPONSE_HEADER,
  type AcceptEntry,
  type PaymentResponseBody,
} from '../lib/x402/protocol.js';
import { readAssetInfo, readBalance } from '../lib/x402/eip3009.js';
import {
  selectHandler,
  readPermit2Allowance,
  CANONICAL_PERMIT2_ADDRESS,
  PERMIT2_ALLOWANCE_ABI,
  type SchemeHandler,
} from '../lib/x402/handlers.js';
import type { GlobalOptions } from '../types.js';

interface SubOptions {
  header?: string[];
  data?: string;
  x402Threshold?: string;
  yes?: boolean;
  include?: boolean;
  x402ApprovePermit2?: boolean;
}

interface PaymentSummary {
  paid: boolean;
  scheme: string;
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
        'Supports x402 v1 (exact / EIP-3009) and v2 (upto / Permit2).',
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
    .option(
      '--x402-approve-permit2',
      'auto-approve the one-time Permit2 ERC-20 allowance needed by the upto scheme',
    )
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
    challenge = parseChallenge(readChallenge(initial));
  } catch (e) {
    process.stderr.write(
      `x402: server returned 402 but the body is not a valid challenge: ${(e as Error).message}\n`,
    );
    process.stderr.write(safeBodyPreview(initial.body));
    process.exit(2);
  }

  let accept: AcceptEntry | undefined;
  let handler: SchemeHandler | undefined;
  for (const candidate of challenge.accepts) {
    const h = selectHandler(candidate, cfg.chain.id);
    if (h) {
      accept = candidate;
      handler = h;
      break;
    }
  }
  if (!accept || !handler) {
    const offered = challenge.accepts
      .map((a) => `${a.scheme}@${a.network} (${a.asset})`)
      .join(', ');
    process.stderr.write(
      `x402: no compatible payment option for network=${networkIdForChain(cfg.chain.id)}. ` +
        `Supported: exact@v1, upto@v2. Server offered: ${offered}\n`,
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
  const isUpto = handler.scheme === 'upto';

  if (balance < accept.maxAmountRequired) {
    process.stderr.write(
      `x402: insufficient balance. Need ${isUpto ? 'up to ' : ''}${amountStr} ${symbol}, ` +
        `have ${balanceStr} ${symbol}.\n`,
    );
    process.exit(1);
  }

  const decided = await decideAutoPay(subOpts, accept, asset.decimals);
  if (decided === 'refuse-no-tty') {
    writeChallengeSummary(accept, asset.decimals, asset.symbol, balanceStr, isUpto);
    process.exit(2);
  }
  if (decided === 'prompt') {
    const verbText = isUpto ? `Authorize up to ${amountStr}` : `Pay ${amountStr}`;
    const proceed = await confirm({
      message: `${verbText} ${symbol} to ${accept.payTo}? (balance: ${balanceStr} ${symbol})`,
      default: false,
    });
    if (!proceed) {
      process.stderr.write('x402: payment declined.\n');
      process.exit(1);
    }
  }

  // upto rides on Permit2: the payer must have a one-time ERC-20 approval for Permit2.
  if (isUpto) {
    const ok = await ensurePermit2Allowance(
      client,
      cfg,
      account,
      accept,
      asset.decimals,
      symbol,
      subOpts,
    );
    if (!ok) process.exit(1);
  }

  let built;
  try {
    built = await handler.buildPayload(accept, {
      account,
      chainId: cfg.chain.id,
      x402Version: challenge.x402Version,
      assetName: asset.name,
      assetVersion: asset.version,
      amount: accept.maxAmountRequired,
      url,
    });
  } catch (e) {
    process.stderr.write(`x402: failed to build ${handler.scheme} payment: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const retryHeaders = new Headers(reqHeaders);
  retryHeaders.set(built.headerName, built.headerValueBase64);

  const retry = await runRequest(verb as HttpVerb, url, {
    headers: retryHeaders,
    body,
    redirect: 'manual',
  });

  if (retry.status >= 300 && retry.status < 400) {
    const loc = retry.headers.get('location');
    if (!loc || !sameOrigin(url, new URL(loc, url).toString())) {
      process.stderr.write(
        'x402: server redirected the paid request cross-origin; refusing to replay the payment header.\n',
      );
      process.exit(1);
    }
  }

  if (retry.status === 412) {
    process.stderr.write(
      'x402: facilitator rejected the payment — Permit2 allowance required (412). ' +
        'Re-run with --x402-approve-permit2 to grant it.\n',
    );
    process.stderr.write(safeBodyPreview(retry.body));
    process.exit(1);
  }

  let paymentResponse: PaymentResponseBody | null = null;
  const xpr =
    retry.headers.get(V2_PAYMENT_RESPONSE_HEADER) ?? retry.headers.get(V1_PAYMENT_RESPONSE_HEADER);
  if (xpr) {
    try { paymentResponse = decodePaymentResponse(xpr); } catch { /* ignore malformed */ }
  }

  // For upto the facilitator reports the actual charged amount; fall back to the max.
  const settledWei = paymentResponse?.amount ?? accept.maxAmountRequired.toString();
  const settledStr = formatUnits(BigInt(settledWei), asset.decimals);

  const summary: PaymentSummary = {
    paid: retry.status >= 200 && retry.status < 300,
    scheme: handler.scheme,
    asset: accept.asset,
    assetSymbol: asset.symbol,
    amount: settledStr,
    amountWei: settledWei,
    payTo: accept.payTo,
    txHash: paymentResponse?.transaction || undefined,
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

/** Read the v2 PAYMENT-REQUIRED header (base64 JSON) if present, else the JSON body. */
function readChallenge(res: HttpResponse): unknown {
  const v2 = res.headers.get(V2_PAYMENT_REQUIRED_HEADER);
  if (v2) {
    return JSON.parse(Buffer.from(v2, 'base64').toString('utf8'));
  }
  const text = decodeBodyAsUtf8(res.body) ?? '';
  return JSON.parse(text);
}

/**
 * Ensure the payer has approved the canonical Permit2 contract for at least the
 * authorized max. Sends an approve tx if missing (prompting unless -y / --x402-approve-permit2).
 * Returns false when the user declines or there's no way to proceed.
 */
async function ensurePermit2Allowance(
  client: ReturnType<typeof makePublicClient>,
  cfg: ReturnType<typeof resolveConfig>,
  account: Awaited<ReturnType<typeof requireAccount>>,
  accept: AcceptEntry,
  decimals: number,
  symbol: string,
  subOpts: SubOptions,
): Promise<boolean> {
  let allowance: bigint;
  try {
    allowance = await readPermit2Allowance(
      client,
      accept.asset,
      account.address,
      CANONICAL_PERMIT2_ADDRESS,
    );
  } catch (e) {
    process.stderr.write(`x402: failed to read Permit2 allowance: ${(e as Error).message}\n`);
    return false;
  }
  if (allowance >= accept.maxAmountRequired) return true;

  const needStr = formatUnits(accept.maxAmountRequired, decimals);
  const auto = subOpts.yes || subOpts.x402ApprovePermit2;
  if (!auto) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `x402: upto requires a one-time Permit2 approval for ${symbol} (have ` +
          `${formatUnits(allowance, decimals)}, need ${needStr}). ` +
          'Re-run with --x402-approve-permit2 (or -y) to grant it.\n',
      );
      return false;
    }
    const proceed = await confirm({
      message: `Approve Permit2 (${CANONICAL_PERMIT2_ADDRESS}) to spend ${symbol}? (one-time, required by upto)`,
      default: false,
    });
    if (!proceed) {
      process.stderr.write('x402: Permit2 approval declined.\n');
      return false;
    }
  }

  try {
    const walletClient = makeWalletClient(cfg, account);
    const data = encodeFunctionData({
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: 'approve',
      args: [CANONICAL_PERMIT2_ADDRESS, maxUint256],
    });
    const gasPrice = await client.getGasPrice();
    const hash = await walletClient.sendTransaction({
      account,
      to: accept.asset,
      data,
      gasPrice,
      type: 'legacy',
      chain: cfg.chain,
    });
    process.stderr.write(`x402: sent Permit2 approval (tx ${hash}); waiting for confirmation…\n`);
    await client.waitForTransactionReceipt({ hash });
    return true;
  } catch (e) {
    process.stderr.write(`x402: Permit2 approval failed: ${(e as Error).message}\n`);
    return false;
  }
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
    // For upto, maxAmountRequired is the authorized ceiling; compare against it.
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
  isUpto: boolean,
): void {
  const amount = formatUnits(accept.maxAmountRequired, decimals);
  const tag = symbol ?? accept.asset;
  const lead = isUpto
    ? `payment required (authorize up to ${amount} ${tag}, charged on use, to ${accept.payTo}).`
    : `payment required (${amount} ${tag} to ${accept.payTo}).`;
  process.stderr.write(
    [
      `x402: ${lead}`,
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
  if (payment?.paid) {
    const tag = payment.assetSymbol ?? payment.asset;
    const tx = payment.txHash ? ` (tx ${payment.txHash})` : '';
    process.stderr.write(`x402: paid ${payment.amount} ${tag}${tx}\n`);
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
