import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayloadResult, PaymentRequired, PaymentRequirements, PaymentRequirementsV1, SchemeNetworkClient } from '@x402/core/types';
import { ExactEvmScheme, UptoEvmScheme, toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import { createPublicClient, createWalletClient, http, isAddress, maxUint256, type Account, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, resolvePrice, type Price } from '../amounts.js';
import { getBalances, type AccountBalances } from '../balances.js';
import { toTokenAtomic, type TokenAmount, type TxResult } from '../erc20.js';
import { RadiusPaymentError } from '../errors.js';
import { describeSupportedSchemes } from '../schemes.js';
import { PERMIT2_ADDRESS, resolveNetwork, type Address, type NetworkInput, type NetworkOverrides, type RadiusNetwork } from '../networks.js';
import { decodePaymentReceipt, parseUptoSettlementAmount, type PaymentReceipt } from '../receipt.js';
import { getSettlement, type Settlement } from '../settlement.js';

/**
 * Who pays: a private key, a viem local account (or any `{ address, signTypedData }`),
 * or a viem WalletClient with an account (e.g. MetaMask via `custom(window.ethereum)`).
 */
export type RadiusSigner = `0x${string}` | ClientEvmSigner | WalletClient;

/** x402 payment schemes this client can pay. */
export type PaymentScheme = 'exact' | 'upto';

/** A challenge entry from either protocol version (v1 prices in `maxAmountRequired`, v2 in `amount`). */
export type AnyPaymentRequirements = PaymentRequirements | PaymentRequirementsV1;

/** What a server is asking for, presented to `onPaymentRequired` before anything is signed. */
export interface PaymentOffer {
  /** x402 protocol version of the challenge: v1 pays with `X-PAYMENT`, v2 with `PAYMENT-SIGNATURE`. */
  x402Version: 1 | 2;
  /** `exact`: pay exactly `amount`. `upto`: authorise up to `amount`; the facilitator charges what was used. */
  scheme: PaymentScheme;
  /** Atomic amount, e.g. "10000". For `upto` this is the authorised maximum, not what will be charged. */
  amount: string;
  /** Display amount, e.g. "0.01 SBC". */
  amountFormatted: string;
  asset: Address;
  payTo: Address;
  network: string;
  resource: { url: string; description?: string; mimeType?: string };
  /** Untouched requirement chosen from the 402 (a v1 entry when `x402Version` is 1). */
  requirements: AnyPaymentRequirements;
  /** How the asset moves: `permit2` needs a one-time ERC-20 approval (unless sponsored), `eip3009` does not. */
  transferMethod: 'permit2' | 'eip3009';
  /** True when the server's facilitator will sponsor the one-time Permit2 approval. */
  gasSponsored: boolean;
}

/**
 * An allowance change the client is about to make, handed to `onApprovalRequired` before anything
 * is signed. Every path that changes an allowance goes through it: the automatic Permit2 approval
 * during a payment (`reason: 'payment'`, with the `offer`), an explicit `approvePermit2()`
 * (`'approvePermit2'`), and `approve(spender, amount)` (`'approve'`). The request is also the
 * `details` of the `declined` error, so a policy layer has one auditable object either way.
 */
export interface ApprovalRequest {
  /** Which call is asking. */
  reason: 'payment' | 'approvePermit2' | 'approve';
  asset: Address;
  spender: Address;
  /** Amount to approve: unlimited for Permit2 (the x402 "one-time gas approval" model), the caller's amount for `approve`. */
  amount: bigint;
  currentAllowance: bigint;
  /** The payment that needs the approval; only for `reason: 'payment'`. */
  offer?: PaymentOffer;
}

/** `details` of a `payment_rejected` error: the server's second 402, unread. */
export interface PaymentRejectedDetails {
  response: Response;
  /** `error` from the decoded `PAYMENT-REQUIRED` header, when the server sent one. */
  error?: string;
  challenge?: PaymentRequired;
}

/** `details` of an `invalid_challenge` error raised while parsing a 402. */
export interface InvalidChallengeDetails {
  response: Response;
  /** Body text, when it had to be read to look for a challenge. */
  body?: string;
  cause: unknown;
}

export interface RadiusFetchOptions extends NetworkOverrides {
  /** 'mainnet' (default), 'testnet', a preset, or a custom instance. */
  network?: NetworkInput;
  signer: RadiusSigner;
  /**
   * Hard ceiling per request, e.g. "$0.05" or { amount: "50000" }. Required.
   * This is NOT a cumulative budget: an agent looping over requests can exceed
   * any total unless you enforce one outside the SDK.
   */
  maxPerRequest: Price;
  /** Approve or decline an offer before signing. Return false to decline. */
  onPaymentRequired?: (offer: PaymentOffer) => boolean | Promise<boolean>;
  /**
   * Permit2 needs a one-time ERC-20 approval. When the server's facilitator sponsors it
   * (`eip2612GasSponsoring`) nothing is sent on-chain. Otherwise: 'auto' (default) sends an
   * unlimited approval transaction from the signer (gas via Turnstile from SBC, so the wallet
   * needs ~0.01 SBC spare on Radius); 'never' throws `approval_required` instead.
   */
  permit2Approval?: 'auto' | 'never';
  /**
   * Approve or decline an allowance change before it is signed: the automatic Permit2 approval of
   * a payment, `approvePermit2()` and `approve()` all pass through here (`request.reason` says
   * which). Return false to decline (`declined` error carrying the request).
   */
  onApprovalRequired?: (request: ApprovalRequest) => boolean | Promise<boolean>;
  /** Called with the decoded receipt after a paid response. */
  onPaid?: (receipt: PaymentReceipt, offer: PaymentOffer) => void | Promise<void>;
  /** Underlying fetch (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export type { TxResult } from '../erc20.js';

export interface FaucetResult {
  success: boolean;
  /** Display amount dripped, e.g. "0.5". */
  amount?: string;
  txHash?: `0x${string}`;
  raw: unknown;
}

export interface RadiusFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly address: Address;
  readonly network: RadiusNetwork;
  /** Atomic cap per request. */
  readonly maxPerRequest: bigint;
  /** Payment-asset (SBC) balance of the signer: a raw ERC-20 `balanceOf`, nothing aggregated. */
  balance(): Promise<{ atomic: bigint; formatted: string }>;
  /**
   * Native RUSD, payment-asset and aggregate balances of the signer, reported separately.
   * On Radius `eth_getBalance` is native plus convertible stablecoins; see `getBalances`.
   */
  balances(): Promise<AccountBalances>;
  /** Current ERC-20 allowance granted to Permit2 for the payment asset. */
  permit2Allowance(): Promise<bigint>;
  /** Send an unlimited Permit2 approval now (rather than lazily on first unsponsored payment). Subject to `onApprovalRequired`. */
  approvePermit2(): Promise<TxResult>;
  /** Transfer the payment asset. Needs a transaction-capable signer (private key or viem local account). */
  send(to: Address, amount: Price): Promise<TxResult>;
  /** Payment-asset allowance the signer has granted to `spender` (atomic units). */
  allowance(spender: Address): Promise<bigint>;
  /**
   * Approve `spender` for `amount` of the payment asset (bigint atomic, or "1.5" in display units).
   * Subject to `onApprovalRequired` (`reason: 'approve'`), like every allowance change this client makes.
   */
  approve(spender: Address, amount: TokenAmount): Promise<TxResult>;
  /** Reconcile a settlement transaction on-chain (undefined while unknown to the node). */
  getSettlement(txHash: `0x${string}`): Promise<Settlement | undefined>;
  /** Request a faucet drip for this wallet (testnet ~0.5 SBC; mainnet ~0.01 SBC/day). */
  fund(): Promise<FaucetResult>;
  /** Escape hatch to the underlying x402 client. */
  readonly client: x402Client;
}

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const SPONSORING_KEYS = ['eip2612GasSponsoring', 'erc20ApprovalGasSponsoring'];
/**
 * Longest signing window we will authorise, and the default when a challenge omits
 * `maxTimeoutSeconds`. An authorisation the facilitator fails to settle stays redeemable until
 * its deadline, so the server's value is clamped rather than trusted (matches radius-cli).
 */
const MAX_TIMEOUT_SECONDS = 600;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ATOMIC_AMOUNT = /^[0-9]+$/;

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

function isSigner(v: unknown): v is ClientEvmSigner {
  return typeof v === 'object' && v !== null && 'address' in v && typeof (v as ClientEvmSigner).signTypedData === 'function';
}

function isWalletClient(v: unknown): v is WalletClient {
  const w = v as WalletClient;
  return typeof v === 'object' && v !== null && typeof w.request === 'function' && typeof w.writeContract === 'function' && typeof w.signTypedData === 'function';
}

function isTxAccount(v: unknown): v is Account {
  return typeof v === 'object' && v !== null && typeof (v as Account).signTransaction === 'function';
}

/**
 * Create a `fetch` that pays Radius x402 challenges automatically, within a
 * per-request ceiling, on one network, in one asset.
 */
export function createRadiusFetch(options: RadiusFetchOptions): RadiusFetch {
  const network = resolveNetwork(options.network, options);
  if (options.maxPerRequest === undefined || options.maxPerRequest === null) {
    throw new RadiusPaymentError('config', 'createRadiusFetch: maxPerRequest is required (e.g. "$0.05")');
  }
  const cap = BigInt(resolvePrice(options.maxPerRequest, network.asset).amount);
  const chain = network.chain;
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
  let account: ClientEvmSigner;
  let walletClient: WalletClient | undefined;
  if (typeof options.signer === 'string') {
    const local = privateKeyToAccount(options.signer);
    account = local as unknown as ClientEvmSigner;
    walletClient = createWalletClient({ account: local, chain, transport: http(network.rpcUrl) });
  } else if (isWalletClient(options.signer)) {
    const wc = options.signer;
    const wcAccount = wc.account;
    if (!wcAccount) throw new RadiusPaymentError('config', 'createRadiusFetch: the WalletClient has no account; create it with { account }');
    account = {
      address: wcAccount.address,
      signTypedData: (msg) => wc.signTypedData({ ...(msg as Omit<Parameters<WalletClient['signTypedData']>[0], 'account'>), account: wcAccount } as Parameters<WalletClient['signTypedData']>[0]),
      signMessage: (a: { message: string }) => wc.signMessage({ account: wcAccount, message: a.message }),
    } as ClientEvmSigner;
    walletClient = wc;
  } else {
    account = options.signer;
    if (!isSigner(account)) throw new RadiusPaymentError('config', 'createRadiusFetch: signer must be a private key, a WalletClient with an account, or an object with address + signTypedData');
    if (isTxAccount(account)) walletClient = createWalletClient({ account, chain, transport: http(network.rpcUrl) });
  }
  // readContract on the signer lets @x402/evm sign the EIP-2612 permit for gas sponsoring.
  const signer = toClientEvmSigner(account, publicClient as never);

  const exactScheme = new ExactEvmScheme(signer, { rpcUrl: network.rpcUrl });
  // x402 v1 `exact` is EIP-3009 only. @x402/evm's own ExactEvmSchemeV1 resolves the chain id from a
  // table of named v1 networks (base-sepolia, …) and rejects `eip155:<chainId>`, which is how Radius
  // appears in v1 challenges. ExactEvmScheme's EIP-3009 signing is version-agnostic (same EIP-712
  // domain/types, `validAfter: 0`), so delegate to it with the v1 price field normalised and wrap the
  // result in the v1 envelope `{ x402Version, scheme, network, payload }`.
  const exactV1Scheme: SchemeNetworkClient = {
    scheme: 'exact',
    async createPaymentPayload(x402Version, requirements) {
      const v1 = requirements as unknown as PaymentRequirementsV1;
      const { assetTransferMethod: _v2Only, ...extra } = v1.extra ?? {};
      const result = await exactScheme.createPaymentPayload(x402Version, { ...v1, amount: v1.maxAmountRequired, extra } as PaymentRequirements);
      return { x402Version, scheme: v1.scheme, network: v1.network, payload: result.payload } as PaymentPayloadResult;
    },
  };
  const client = new x402Client()
    .register(network.network, exactScheme)
    .register(network.network, new UptoEvmScheme(signer, { rpcUrl: network.rpcUrl }))
    .registerV1(network.network, exactV1Scheme)
    // Backstop; the primary checks live in `chooseOffer` so errors are typed.
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: network.network, asset: network.asset.address, maxAmountPerPayment: cap.toString() }],
    });
  const httpClient = new x402HTTPClient(client);
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const explorer = (hash: string) => (network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined);

  const requireWallet = (what: string): WalletClient => {
    if (!walletClient) {
      throw new RadiusPaymentError('approval_required', `${what} needs a transaction-capable signer (a private key, viem local account, or WalletClient); this signer can only sign typed data`);
    }
    return walletClient;
  };

  const sendTx = async (what: string, fn: (wc: WalletClient) => Promise<`0x${string}`>): Promise<TxResult> => {
    const wc = requireWallet(what);
    const hash = await fn(wc);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status === 'success' ? 'success' : 'reverted', explorerUrl: explorer(hash) };
  };

  const permit2Allowance = () =>
    publicClient.readContract({ address: network.asset.address, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, PERMIT2_ADDRESS] });

  const allowance = (spender: Address) =>
    publicClient.readContract({ address: network.asset.address, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender] });

  /** The one policy gate for allowance changes: `onApprovalRequired` may veto, else proceed. */
  const authorizeApproval = async (request: ApprovalRequest): Promise<void> => {
    if (options.onApprovalRequired && !(await options.onApprovalRequired(request))) {
      throw new RadiusPaymentError('declined', `${request.reason === 'payment' ? 'Permit2' : request.reason} approval declined`, request);
    }
  };

  /** ERC-20 `approve` of the payment asset, after `authorizeApproval`. */
  const sendApproval = async (request: ApprovalRequest, what: string): Promise<TxResult> => {
    await authorizeApproval(request);
    const r = await sendTx(what, (wc) =>
      wc.writeContract({ address: network.asset.address, abi: ERC20_ABI, functionName: 'approve', args: [request.spender, request.amount], chain, account: wc.account! }),
    );
    if (r.status !== 'success') throw new RadiusPaymentError('approval_failed', `${what} transaction ${r.hash} reverted`, r);
    return r;
  };

  const approvePermit2 = async (): Promise<TxResult> => {
    const currentAllowance = await permit2Allowance();
    return sendApproval({ reason: 'approvePermit2', asset: network.asset.address, spender: PERMIT2_ADDRESS, amount: maxUint256, currentAllowance }, 'Permit2 approval');
  };

  const approve = async (spender: Address, amount: TokenAmount): Promise<TxResult> => {
    const [atomic, currentAllowance] = await Promise.all([toTokenAtomic(publicClient, network.asset, amount), allowance(spender)]);
    return sendApproval({ reason: 'approve', asset: network.asset.address, spender, amount: atomic, currentAllowance }, 'approve');
  };

  const amountOf = (version: 1 | 2, a: AnyPaymentRequirements): bigint => {
    const field = version === 1 ? 'maxAmountRequired' : 'amount';
    const raw = (a as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || !ATOMIC_AMOUNT.test(raw)) {
      throw new RadiusPaymentError('invalid_challenge', `Offer ${field} must be a non-negative integer string (got ${JSON.stringify(raw)})`, a);
    }
    return BigInt(raw);
  };

  const chooseOffer = (pr: PaymentRequired, requestUrl: string): PaymentOffer => {
    const version = pr.x402Version;
    if (version !== 1 && version !== 2) throw new RadiusPaymentError('invalid_challenge', `Unsupported x402 version ${String(version)}`);
    const accepts = pr.accepts as AnyPaymentRequirements[] | undefined;
    if (!Array.isArray(accepts) || accepts.length === 0) throw new RadiusPaymentError('invalid_challenge', 'Challenge has no accepts[]');
    const sameNetwork = accepts.filter((a) => a.network === network.network);
    if (sameNetwork.length === 0) {
      const offered = [...new Set(accepts.map((a) => a.network))].join(', ') || 'none';
      throw new RadiusPaymentError('network_mismatch', `Server accepts ${offered}; this client pays on ${network.network} (${network.name})`, accepts);
    }
    const sameAsset = sameNetwork.filter((a) => typeof a.asset === 'string' && a.asset.toLowerCase() === network.asset.address.toLowerCase());
    if (sameAsset.length === 0) {
      throw new RadiusPaymentError('asset_mismatch', `Server does not accept ${network.asset.symbol} (${network.asset.address}) on ${network.network}`, sameNetwork);
    }
    // `exact` exists in v1 and v2; `upto` is a v2 scheme only.
    const knownScheme = sameAsset.filter((a) => a.scheme === 'exact' || (a.scheme === 'upto' && version === 2));
    if (knownScheme.length === 0) {
      const schemes = [...new Set(sameAsset.map((a) => `${a.scheme}@v${version}`))].join(', ');
      throw new RadiusPaymentError('no_compatible_offer', `Server offers ${schemes} for ${network.asset.symbol}; this client supports ${describeSupportedSchemes()}`, sameAsset);
    }
    // v1 `exact` is always EIP-3009 and `upto` always Permit2; v2 `exact` names its transfer method.
    const supported = knownScheme.filter((a) => {
      if (version === 1 || a.scheme === 'upto') return true;
      const m = a.extra?.assetTransferMethod;
      return m === undefined || m === 'permit2' || m === 'eip3009';
    });
    if (supported.length === 0) {
      const methods = [...new Set(knownScheme.map((a) => String(a.extra?.assetTransferMethod)))].join(', ');
      throw new RadiusPaymentError('unsupported_transfer_method', `Server requires assetTransferMethod ${methods}; this client supports permit2 and eip3009`, knownScheme);
    }
    // Server order is the server's preference (x402 clients honour it; so did radius-cli): take the
    // first offer within the cap. Amounts are not compared across schemes — an `upto` amount is a
    // ceiling, not a price.
    const priced = supported.map((req) => ({ req, amount: amountOf(version, req) }));
    const affordable = priced.find((p) => p.amount <= cap);
    if (!affordable) {
      const { req: first, amount: firstAmount } = priced[0];
      const offered = formatAmount(firstAmount, network.asset.decimals, network.asset.symbol);
      const limit = formatAmount(cap, network.asset.decimals, network.asset.symbol);
      throw new RadiusPaymentError(
        'price_above_limit',
        first.scheme === 'upto' ? `Offer authorises up to ${offered}, exceeding maxPerRequest ${limit}` : `Offer ${offered} exceeds maxPerRequest ${limit}`,
        priced.map((p) => p.req),
      );
    }
    const { req, amount } = affordable;
    const scheme = req.scheme as PaymentScheme;
    if (typeof req.payTo !== 'string' || !isAddress(req.payTo)) {
      throw new RadiusPaymentError('invalid_challenge', `Offer payTo is not an address (got ${JSON.stringify(req.payTo)})`, req);
    }
    if (scheme === 'upto') {
      const facilitator = req.extra?.facilitatorAddress ?? req.extra?.facilitator;
      if (typeof facilitator !== 'string' || !isAddress(facilitator)) {
        throw new RadiusPaymentError('invalid_challenge', 'upto offer is missing a valid extra.facilitatorAddress; cannot bind the Permit2 witness', req);
      }
    }
    const gasSponsored = SPONSORING_KEYS.some((k) => pr.extensions !== undefined && k in pr.extensions);
    // v1 has no top-level resource; its accepts[] carry description/mimeType.
    const v1 = req as Partial<PaymentRequirementsV1>;
    const resource = version === 2 && pr.resource ? pr.resource : { url: requestUrl, description: v1.description, mimeType: v1.mimeType };
    return {
      x402Version: version,
      scheme,
      amount: amount.toString(),
      amountFormatted: formatAmount(amount, network.asset.decimals, network.asset.symbol),
      asset: req.asset as Address,
      payTo: req.payTo as Address,
      network: req.network,
      resource,
      requirements: req,
      transferMethod: scheme === 'upto' || (version === 2 && req.extra?.assetTransferMethod === 'permit2') ? 'permit2' : 'eip3009',
      gasSponsored,
    };
  };

  /**
   * The requirement handed to @x402/evm for signing. Fills in what the schemes need but a server may
   * omit: the configured asset's EIP-712 domain (EIP-3009 / EIP-2612), a signing window, and the
   * `extra.facilitator` alias radius-cli accepts for `facilitatorAddress`. Only the signer sees this;
   * the untouched requirement is what gets echoed back to the server.
   */
  const forSigning = (offer: PaymentOffer): PaymentRequirements => {
    const req = offer.requirements;
    const extra: Record<string, unknown> = { name: network.asset.name, version: network.asset.version, ...req.extra };
    if (extra.facilitatorAddress === undefined && typeof extra.facilitator === 'string') extra.facilitatorAddress = extra.facilitator;
    const t = req.maxTimeoutSeconds;
    const maxTimeoutSeconds = typeof t === 'number' && t > 0 ? Math.min(Math.floor(t), MAX_TIMEOUT_SECONDS) : MAX_TIMEOUT_SECONDS;
    return { ...req, maxTimeoutSeconds, extra } as PaymentRequirements;
  };

  /** Permit2 needs an ERC-20 allowance. Sponsored: the scheme signs a permit. Unsponsored: approve on-chain once. */
  const ensureAllowance = async (offer: PaymentOffer): Promise<void> => {
    if (offer.transferMethod !== 'permit2' || offer.gasSponsored) return;
    const current = await permit2Allowance();
    if (current >= BigInt(offer.amount)) return;
    const request: ApprovalRequest = { reason: 'payment', asset: network.asset.address, spender: PERMIT2_ADDRESS, amount: maxUint256, currentAllowance: current, offer };
    if ((options.permit2Approval ?? 'auto') === 'never') {
      throw new RadiusPaymentError('approval_required', `Permit2 allowance ${current} is below ${offer.amount} and the facilitator does not sponsor approvals; call approvePermit2() or set permit2Approval: 'auto'`, request);
    }
    await sendApproval(request, 'Permit2 approval');
  };

  /**
   * v2: `PAYMENT-REQUIRED` header (or, off-spec but seen in the wild, a JSON body); v1: JSON body.
   * Throws `invalid_challenge` with `{ response, body, cause }` so callers can show what the server sent.
   */
  const readChallenge = async (res: Response): Promise<PaymentRequired> => {
    let text: string | undefined;
    let body: unknown;
    try {
      if (!res.headers.get('payment-required')) {
        text = await res.text();
        if (text) body = JSON.parse(text);
      }
      try {
        return httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      } catch (e) {
        if (body && typeof body === 'object' && !Array.isArray(body) && (body as { x402Version?: unknown }).x402Version === 2) return body as PaymentRequired;
        throw e;
      }
    } catch (e) {
      throw new RadiusPaymentError('invalid_challenge', `Could not parse the 402 challenge: ${(e as Error).message}`, { response: res, body: text, cause: e });
    }
  };

  /**
   * Decode the settlement receipt. For `upto` the reported `amount` is untrusted input: it must be a
   * non-negative integer no greater than the signed maximum, else `invalid_receipt`. `exact` receipts
   * are decoded leniently (a malformed one just means no receipt).
   */
  const decodeReceipt = (header: string, offer: PaymentOffer): PaymentReceipt | undefined => {
    let receipt: PaymentReceipt;
    try {
      receipt = decodePaymentReceipt(header, network);
    } catch (e) {
      if (offer.scheme === 'upto') throw new RadiusPaymentError('invalid_receipt', `Invalid upto payment response: ${(e as Error).message}`, e);
      return undefined;
    }
    if (offer.scheme === 'upto' && receipt.amount !== undefined) {
      try {
        parseUptoSettlementAmount(receipt.amount, BigInt(offer.amount));
      } catch (e) {
        throw new RadiusPaymentError('invalid_receipt', `Invalid upto payment response: ${(e as Error).message}`, receipt);
      }
    }
    // `exact` settles the offered amount; `upto` facilitators report what they charged (else assume the maximum).
    if (receipt.success && receipt.amount === undefined) receipt.amount = offer.amount;
    return receipt;
  };

  const paidFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.headers.has('payment-signature') || request.headers.has('x-payment')) {
      return baseFetch(request);
    }
    // The paid retry never follows redirects: a 3xx must not carry the payment header to another origin.
    const retry = new Request(request.clone(), { redirect: 'manual' });
    const first = await baseFetch(request);
    if (first.status !== 402) return first;

    const paymentRequired = await readChallenge(first);
    const offer = chooseOffer(paymentRequired, request.url);
    if (options.onPaymentRequired && !(await options.onPaymentRequired(offer))) {
      throw new RadiusPaymentError('declined', `Payment of ${offer.amountFormatted} to ${offer.payTo} declined`, offer);
    }
    await ensureAllowance(offer);

    // Narrow the challenge to the chosen offer so the upstream selector cannot pick another.
    const narrowed: PaymentRequired = { ...paymentRequired, accepts: [forSigning(offer)] };
    const payload = await client.createPaymentPayload(narrowed);
    // v2 servers match `accepted` against the requirement they sent (core fields equal, their `extra`
    // a subset of ours), so echo it untouched rather than the filled-in signing copy.
    if (payload.x402Version === 2) payload.accepted = offer.requirements as PaymentRequirements;
    for (const [k, v] of Object.entries(httpClient.encodePaymentSignatureHeader(payload))) retry.headers.set(k, v);
    retry.headers.set('Access-Control-Expose-Headers', 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE');

    const second = await baseFetch(retry);
    if (REDIRECT_STATUSES.has(second.status)) {
      const location = second.headers.get('location');
      let target: URL | undefined;
      try {
        target = location ? new URL(location, retry.url) : undefined;
      } catch {
        /* malformed Location: refused below */
      }
      if (!target || !sameOrigin(target, new URL(retry.url))) {
        throw new RadiusPaymentError(
          'redirect_refused',
          `Server redirected the paid request to ${location ?? '(no Location)'}; refusing to replay the payment header across origins`,
          { status: second.status, location },
        );
      }
      // Same-origin: handed back unfollowed. Re-requesting the target is the caller's call (it may cost another payment).
      return second;
    }
    const header = second.headers.get('payment-response') ?? second.headers.get('x-payment-response');
    if (second.status === 402) {
      // The body is left unread: `details.response` is the server's answer for the caller to inspect.
      let challenge: PaymentRequired | undefined;
      try {
        challenge = httpClient.getPaymentRequiredResponse((n) => second.headers.get(n));
      } catch {
        /* no decodable PAYMENT-REQUIRED header */
      }
      const details: PaymentRejectedDetails = { response: second, error: challenge?.error, challenge };
      throw new RadiusPaymentError('payment_rejected', `Server rejected the payment (${challenge?.error ?? 'no reason given'})`, details);
    }
    if (header) {
      const receipt = decodeReceipt(header, offer);
      if (receipt && options.onPaid) {
        try {
          await options.onPaid(receipt, offer);
        } catch (e) {
          console.error('radius-sdk onPaid hook failed:', e);
        }
      }
    }
    return second;
  };

  const balance = async () => {
    const atomic = await publicClient.readContract({ address: network.asset.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    return { atomic, formatted: formatAmount(atomic, network.asset.decimals, network.asset.symbol) };
  };

  const balances = () => getBalances(publicClient, { address: account.address, network });

  const send = (to: Address, amount: Price): Promise<TxResult> => {
    const atomic = BigInt(resolvePrice(amount, network.asset).amount);
    return sendTx('send', (wc) =>
      wc.writeContract({ address: network.asset.address, abi: ERC20_ABI, functionName: 'transfer', args: [to, atomic], chain, account: wc.account! }),
    );
  };

  const fund = async (): Promise<FaucetResult> => {
    if (!network.faucetUrl) throw new RadiusPaymentError('faucet', `No faucet configured for network ${network.name}`);
    const signMessage = (account as { signMessage?: (a: { message: string }) => Promise<`0x${string}`> }).signMessage;
    if (typeof signMessage !== 'function') throw new RadiusPaymentError('faucet', 'fund() needs a signer with signMessage (EIP-191), e.g. a private key or viem local account');
    const base = network.faucetUrl.replace(/\/+$/, '');
    const token = network.asset.symbol;
    const challenge = (await (await fetch(`${base}/challenge/${account.address}?token=${token}`)).json()) as { message?: string };
    if (!challenge.message) throw new RadiusPaymentError('faucet', 'Faucet returned no challenge message', challenge);
    const signature = await signMessage.call(account, { message: challenge.message });
    const res = await fetch(`${base}/drip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: account.address, token, signature }),
    });
    const raw = (await res.json().catch(() => ({}))) as { success?: boolean; amount?: string; tx_hash?: `0x${string}`; error?: { code?: string; message?: string; retry_after_ms?: number } };
    if (!res.ok || raw.success !== true) {
      throw new RadiusPaymentError('faucet', `Faucet drip failed: ${raw.error?.code ?? res.status} ${raw.error?.message ?? ''}`.trim(), raw);
    }
    return { success: true, amount: raw.amount, txHash: raw.tx_hash, raw };
  };

  return Object.assign(paidFetch, {
    address: account.address,
    network,
    maxPerRequest: cap,
    balance,
    balances,
    permit2Allowance,
    approvePermit2,
    send,
    allowance,
    approve,
    getSettlement: (txHash: `0x${string}`) => getSettlement(network, txHash, publicClient),
    fund,
    client,
  });
}

export { getSettlement } from '../settlement.js';
export type { Settlement, SettlementTransfer } from '../settlement.js';
export { getBalances, getNativeBalance, getAggregateBalance, getTokenBalance, radiusActions, defaultTokens, nativeBalanceBytecode } from '../balances.js';
export type {
  AccountBalances,
  NativeBalance,
  TokenBalance,
  BalanceToken,
  BalanceClient,
  RadiusActions,
  RadiusActionsConfig,
  GetBalancesParameters,
  GetNativeBalanceParameters,
  GetTokenBalanceParameters,
} from '../balances.js';
export {
  erc20Actions,
  getTokenMetadata,
  getAllowance,
  approve,
  transfer,
  transferFrom,
  getTransfers,
  watchTransfers,
  toTokenAtomic,
  formatTokenAmount,
} from '../erc20.js';
export type {
  Erc20Actions,
  Erc20ActionsConfig,
  TokenMetadata,
  TokenTransfer,
  TokenInput,
  TokenAmount,
  TokenWalletClient,
  GetTokenMetadataParameters,
  GetAllowanceParameters,
  ApproveParameters,
  TransferParameters,
  TransferFromParameters,
  GetTransfersParameters,
  WatchTransfersParameters,
} from '../erc20.js';
export { getPaymentReceipt, decodePaymentReceipt, parseUptoSettlementAmount } from '../receipt.js';
export type { PaymentReceipt } from '../receipt.js';
export { RadiusPaymentError } from '../errors.js';
export { radiusEnv } from '../env.js';
export type { RadiusEnvConfig } from '../env.js';
