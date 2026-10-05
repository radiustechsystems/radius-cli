import type { AssetAmount, Network, PaymentRequirements, Price as X402Price, SchemeNetworkServer, SchemePaymentRequiredContext } from '@x402/core/types';
import { resolvePrice, type Price } from '../amounts.js';
import type { RadiusNetwork } from '../networks.js';

export type SettleMode = 'before' | 'after';
/** 'auto': declare gas sponsoring iff the facilitator's /supported lists it. */
export type GasSponsoringMode = 'auto' | boolean;

export const EIP2612_GAS_SPONSORING = 'eip2612GasSponsoring';

/**
 * Server-side `exact` scheme for Radius: prices in USD/SBC, Permit2 transfer method,
 * no dependency on @x402/evm (the facilitator does all the cryptography).
 */
export class RadiusExactScheme implements SchemeNetworkServer {
  readonly scheme = 'exact';
  readonly defaultAssetTransferMethod = 'permit2';
  readonly paymentFlows: SchemeNetworkServer['paymentFlows'];
  /**
   * `paymentFlow` is a server-side hint (when to settle relative to the handler).
   * Clients are not required to echo it, so exclude it from accepted-vs-required
   * matching — stock radius-cli only echoes assetTransferMethod/name/version.
   */
  readonly dynamicExtraFields = ['paymentFlow'];

  private facilitatorExtensions: string[] | undefined;

  constructor(
    private readonly network: RadiusNetwork,
    settle: SettleMode = 'before',
    private readonly gasSponsoring: GasSponsoringMode = 'auto',
  ) {
    this.paymentFlows = {
      permit2: {
        supported: ['authorization', 'upfront'],
        default: settle === 'before' ? 'upfront' : 'authorization',
      },
    };
  }

  async parsePrice(price: X402Price, _network: Network): Promise<AssetAmount> {
    const { amount, asset } = resolvePrice(price as Price, this.network.asset);
    return { amount, asset, extra: {} };
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown> },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    this.facilitatorExtensions = extensionKeys;
    const kindExtra = supportedKind.extra ?? {};
    return {
      ...paymentRequirements,
      extra: {
        assetTransferMethod: kindExtra.assetTransferMethod ?? 'permit2',
        name: kindExtra.name ?? this.network.asset.name,
        version: kindExtra.version ?? this.network.asset.version,
        ...paymentRequirements.extra,
      },
    };
  }

  /** True when 402 responses should declare `eip2612GasSponsoring`. */
  declaresGasSponsoring(): boolean {
    if (this.gasSponsoring !== 'auto') return this.gasSponsoring;
    return this.facilitatorExtensions?.includes(EIP2612_GAS_SPONSORING) ?? true;
  }

  /**
   * Routes declare gas sponsoring statically; strip the declaration when the
   * facilitator does not actually support it, so clients fall back to a normal
   * Permit2 approval instead of sending a permit nobody will honour.
   */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<void> => {
    const ext = ctx.paymentRequiredResponse.extensions;
    if (ext && EIP2612_GAS_SPONSORING in ext && !this.declaresGasSponsoring()) {
      delete ext[EIP2612_GAS_SPONSORING];
      if (Object.keys(ext).length === 0) delete ctx.paymentRequiredResponse.extensions;
    }
  };
}
