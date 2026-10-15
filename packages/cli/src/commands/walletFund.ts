import type { Command } from 'commander';
import { explorerTxUrl, resolveNetwork } from 'radius-sdk';
import { createRadiusFetch, RadiusPaymentError } from 'radius-sdk/client';
import { resolveConfig } from '../lib/config.js';
import { requireAccount } from '../lib/account.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

/**
 * `wallet fund`: one testnet SBC drip from the Radius faucet to the local wallet. The SDK's
 * `fund()` does the work (challenge, EIP-191 signature, `POST /drip`), so the key never leaves
 * the CLI. Testnet only: the CLI defaults to mainnet, and a mainnet drip is limited to one a day.
 */
export function registerWalletFund(wallet: Command): void {
  wallet
    .command('fund')
    .description(
      [
        'Request a testnet SBC drip from the Radius faucet for the local wallet (testnet only).',
        '',
        '  radius-cli --network testnet wallet fund',
        '  RADIUS_NETWORK=testnet radius-cli --json wallet fund',
      ].join('\n'),
    )
    .option('--faucet-url <url>', 'faucet API base URL (default: the network\'s, from radius-sdk)')
    .action(async (subOpts: { faucetUrl?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (cfg.network !== 'testnet') {
        throw new Error(
          'wallet fund drips testnet SBC only; pass --network testnet (or set RADIUS_NETWORK=testnet). ' +
            'On mainnet, fund the wallet by sending it SBC.',
        );
      }
      const network = resolveNetwork('testnet', { rpcUrl: cfg.rpcUrl, faucetUrl: subOpts.faucetUrl });
      const account = await requireAccount(cfg, opts.privateKey);
      // fund() needs no payment cap; the client is only used for its wallet helpers.
      const client = createRadiusFetch({ network, signer: account, maxPerRequest: { amount: '0' } });

      let result;
      try {
        result = await client.fund();
      } catch (err) {
        throw new Error(faucetErrorMessage(err), { cause: err });
      }

      const explorerUrl = result.txHash ? explorerTxUrl(network, result.txHash) : undefined;
      const summary = {
        address: account.address,
        network: network.network,
        token: network.asset.symbol,
        amount: result.amount ?? null,
        txHash: result.txHash ?? null,
        explorerUrl: explorerUrl ?? null,
      };
      if (opts.json) {
        console.log(jsonStringify(summary));
        return;
      }
      console.log(`Funded ${account.address} with ${result.amount ?? 'an unknown amount of'} ${network.asset.symbol}`);
      if (result.txHash) console.log(`Tx: ${result.txHash}`);
      if (explorerUrl) console.log(explorerUrl);
    });
}

/** The SDK's faucet error, plus the server's retry hint when it rate-limits. */
export function faucetErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof RadiusPaymentError) || err.code !== 'faucet') return message;
  const retryMs = (err.details as { error?: { retry_after_ms?: unknown } } | undefined)?.error?.retry_after_ms;
  if (typeof retryMs === 'number' && retryMs > 0) return `${message} (retry in ${Math.ceil(retryMs / 1000)}s)`;
  return message;
}
