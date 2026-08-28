import type { Address, Hex, PrivateKeyAccount, PublicClient } from 'viem';
import {
  encodeBase64Json,
  encodePaymentHeader,
  networkMatchesChain,
  V1_PAYMENT_HEADER,
  V2_PAYMENT_SIGNATURE_HEADER,
  type AcceptEntry,
} from './protocol.js';
import { makeAuthorization, signTransferAuthorization } from './eip3009.js';
import {
  makeExactPermit2Authorization,
  makePermit2Authorization,
  signExactPermit2Authorization,
  signPermit2Authorization,
  PERMIT2_ALLOWANCE_ABI,
  type ExactPermit2Authorization,
  type Permit2Authorization,
} from './permit2.js';

export interface BuildContext {
  account: PrivateKeyAccount;
  chainId: number;
  x402Version: number;
  // Resolved asset metadata for the chosen accept entry.
  assetName?: string;
  assetVersion?: string;
  // The atomic-unit amount to authorize (the max for `upto`).
  amount: bigint;
  // The original request URL (used for the v2 `resource`).
  url: string;
}

export interface BuiltPayload {
  headerName: string;
  headerValueBase64: string;
}

export interface SchemeHandler {
  version: number;
  scheme: string;
  requiresPermit2Approval?: boolean;
  requiresEip3009Metadata?: boolean;
  /** True when this handler can satisfy the offered entry on the configured chain. */
  canHandle(accept: AcceptEntry, chainId: number): boolean;
  buildPayload(accept: AcceptEntry, ctx: BuildContext): Promise<BuiltPayload>;
}

function assetTransferMethod(accept: AcceptEntry): string | undefined {
  const method = accept.extra?.assetTransferMethod;
  return typeof method === 'string' ? method : undefined;
}

function v2Resource(accept: AcceptEntry, ctx: BuildContext) {
  return { url: ctx.url, description: accept.description, mimeType: accept.mimeType };
}

function v2Accepted(accept: AcceptEntry, ctx: BuildContext, extra: Record<string, unknown>) {
  return {
    scheme: accept.scheme,
    network: accept.network,
    amount: ctx.amount.toString(),
    asset: accept.asset,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra,
  };
}

// -- exact@v1 (EIP-3009 transferWithAuthorization) --------------------------------

const exactV1Handler: SchemeHandler = {
  version: 1,
  scheme: 'exact',
  requiresEip3009Metadata: true,
  canHandle(accept, chainId) {
    return accept.scheme === 'exact' && networkMatchesChain(accept.network, chainId);
  },
  async buildPayload(accept, ctx) {
    if (!ctx.assetName || !ctx.assetVersion) {
      throw new Error('exact EIP-3009 payment requires token name and version metadata.');
    }
    const authorization = makeAuthorization({
      from: ctx.account.address,
      to: accept.payTo,
      value: ctx.amount,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const signature = await signTransferAuthorization(ctx.account, {
      asset: accept.asset,
      chainId: ctx.chainId,
      name: ctx.assetName,
      version: ctx.assetVersion,
      authorization,
    });
    const headerValueBase64 = encodePaymentHeader({
      x402Version: 1,
      scheme: accept.scheme,
      network: accept.network,
      payload: { signature, authorization },
    });
    return { headerName: V1_PAYMENT_HEADER, headerValueBase64 };
  },
};

// -- exact@v2 (EIP-3009 or Permit2) ----------------------------------------------

function serializeAuthorization(authorization: ReturnType<typeof makeAuthorization>) {
  return {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };
}

const exactV2Eip3009Handler: SchemeHandler = {
  version: 2,
  scheme: 'exact',
  requiresEip3009Metadata: true,
  canHandle(accept, chainId) {
    const method = assetTransferMethod(accept);
    return accept.scheme === 'exact' && networkMatchesChain(accept.network, chainId) &&
      (method === undefined || method === 'eip3009');
  },
  async buildPayload(accept, ctx) {
    if (!ctx.assetName || !ctx.assetVersion) {
      throw new Error('exact EIP-3009 payment requires token name and version metadata.');
    }
    const authorization = makeAuthorization({
      from: ctx.account.address,
      to: accept.payTo,
      value: ctx.amount,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const signature = await signTransferAuthorization(ctx.account, {
      asset: accept.asset,
      chainId: ctx.chainId,
      name: ctx.assetName,
      version: ctx.assetVersion,
      authorization,
    });
    return {
      headerName: V2_PAYMENT_SIGNATURE_HEADER,
      headerValueBase64: encodeBase64Json({
        x402Version: 2,
        resource: v2Resource(accept, ctx),
        accepted: v2Accepted(accept, ctx, {
          assetTransferMethod: 'eip3009', name: accept.extra?.name, version: accept.extra?.version,
        }),
        payload: { signature, authorization: serializeAuthorization(authorization) },
      }),
    };
  },
};

function serializeExactPermit2Authorization(a: ExactPermit2Authorization): Record<string, unknown> {
  return {
    permitted: { token: a.permitted.token, amount: a.permitted.amount.toString() },
    from: a.from,
    spender: a.spender,
    nonce: a.nonce.toString(),
    deadline: a.deadline.toString(),
    witness: { to: a.witness.to, validAfter: a.witness.validAfter.toString() },
  };
}

const exactV2Permit2Handler: SchemeHandler = {
  version: 2,
  scheme: 'exact',
  requiresPermit2Approval: true,
  canHandle(accept, chainId) {
    return accept.scheme === 'exact' && assetTransferMethod(accept) === 'permit2' &&
      networkMatchesChain(accept.network, chainId);
  },
  async buildPayload(accept, ctx) {
    const authorization = makeExactPermit2Authorization({
      from: ctx.account.address,
      asset: accept.asset,
      payTo: accept.payTo,
      amount: ctx.amount,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const signature = await signExactPermit2Authorization(ctx.account, {
      chainId: ctx.chainId,
      authorization,
    });
    return {
      headerName: V2_PAYMENT_SIGNATURE_HEADER,
      headerValueBase64: encodeBase64Json({
        x402Version: 2,
        resource: v2Resource(accept, ctx),
        accepted: v2Accepted(accept, ctx, {
          assetTransferMethod: 'permit2', name: accept.extra?.name, version: accept.extra?.version,
        }),
        payload: { signature, permit2Authorization: serializeExactPermit2Authorization(authorization) },
      }),
    };
  },
};

// -- upto@v2 (Permit2 permitWitnessTransferFrom via x402UptoPermit2Proxy) ----------

function readFacilitator(accept: AcceptEntry): Address {
  const f = accept.extra?.facilitatorAddress ?? accept.extra?.facilitator;
  if (typeof f !== 'string') {
    throw new Error(
      "upto: the 402 'extra' is missing 'facilitatorAddress'; cannot bind the Permit2 witness.",
    );
  }
  return f as Address;
}

function serializePermit2Authorization(a: Permit2Authorization): Record<string, unknown> {
  return {
    permitted: { token: a.permitted.token, amount: a.permitted.amount.toString() },
    from: a.from,
    spender: a.spender,
    nonce: a.nonce.toString(),
    deadline: a.deadline.toString(),
    witness: {
      to: a.witness.to,
      facilitator: a.witness.facilitator,
      validAfter: a.witness.validAfter.toString(),
    },
  };
}

const uptoV2Handler: SchemeHandler = {
  version: 2,
  scheme: 'upto',
  requiresPermit2Approval: true,
  canHandle(accept, chainId) {
    return accept.scheme === 'upto' && networkMatchesChain(accept.network, chainId);
  },
  async buildPayload(accept, ctx) {
    const facilitator = readFacilitator(accept);
    const authorization = makePermit2Authorization({
      from: ctx.account.address,
      asset: accept.asset,
      payTo: accept.payTo,
      facilitator,
      maxAmount: ctx.amount,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const signature: Hex = await signPermit2Authorization(ctx.account, {
      chainId: ctx.chainId,
      authorization,
    });

    // v2 PaymentPayload: top-level x402Version + resource, the chosen requirements ride
    // in `accepted` (extra reduced to {name,version}), the scheme payload in `payload`.
    const payload = {
      x402Version: 2,
      resource: v2Resource(accept, ctx),
      accepted: v2Accepted(accept, ctx, { name: accept.extra?.name, version: accept.extra?.version }),
      payload: {
        signature,
        permit2Authorization: serializePermit2Authorization(authorization),
      },
    };
    return { headerName: V2_PAYMENT_SIGNATURE_HEADER, headerValueBase64: encodeBase64Json(payload) };
  },
};

// -- registry ---------------------------------------------------------------------

export const HANDLERS: SchemeHandler[] = [
  exactV1Handler,
  exactV2Eip3009Handler,
  exactV2Permit2Handler,
  uptoV2Handler,
];

/** Pick a handler only when its x402 version, scheme, and network all match. */
export function selectHandler(
  x402Version: number,
  accept: AcceptEntry,
  chainId: number,
): SchemeHandler | undefined {
  return HANDLERS.find((h) => h.version === x402Version && h.canHandle(accept, chainId));
}

export {
  assetTransferMethod,
  readFacilitator,
  serializeExactPermit2Authorization,
  serializePermit2Authorization,
};

// Re-export allowance helpers so callers import preflight from one place.
export {
  CANONICAL_PERMIT2_ADDRESS,
  X402_EXACT_PERMIT2_PROXY,
  X402_UPTO_PERMIT2_PROXY,
  PERMIT2_ALLOWANCE_ABI,
} from './permit2.js';

/** Read the payer's ERC-20 allowance granted to the canonical Permit2 contract. */
export async function readPermit2Allowance(
  client: PublicClient,
  asset: Address,
  owner: Address,
  permit2: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: asset,
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, permit2],
  })) as bigint;
}
