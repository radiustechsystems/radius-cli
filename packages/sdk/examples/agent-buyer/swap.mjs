// Swaps stablecoins into (or out of) Radius through the Radius Swap API and follows the session
// to completion. The wallet must hold the source token and gas on the source chain.
//   RADIUS_PRIVATE_KEY=0x… node swap.mjs <amount> [source_chain source_token destination_chain destination_token] [destination_address]
//   RADIUS_PRIVATE_KEY=0x… node swap.mjs 1.5                                   # base_sepolia SBC → radius_testnet SBC (testnet default)
//   RADIUS_PRIVATE_KEY=0x… node swap.mjs 1.5 radius_testnet SBC base_sepolia SBC 0x2222…
//   node swap.mjs --routes                                                      # list supported routes
// RADIUS_NETWORK (default testnet) selects the deployment; RADIUS_SWAP_URL overrides its URL; SWAP_WAIT=0 returns right after broadcast.
import { privateKeyToAccount } from 'viem/accounts';
import { createSwapClient, SwapError } from 'radius-sdk/swap';
import { radiusEnv } from 'radius-sdk';

const env = radiusEnv({ RADIUS_NETWORK: 'testnet', ...process.env });
const swap = createSwapClient({ network: env.network, swapUrl: env.swapUrl });
const args = process.argv.slice(2);

const describeRoute = (r) => `${r.sourceChain}/${r.sourceToken} (chain ${r.sourceChainId}, ${r.sourceTokenContract}) → ${r.destinationChain}/${r.destinationToken} (chain ${r.destinationChainId})`;

try {
  if (args[0] === '--routes' || args.length === 0) {
    const ins = await swap.instructions();
    console.error(`${swap.url} · environment ${ins.environment}`);
    for (const r of ins.routes) console.log(describeRoute(r));
    if (args.length === 0) console.error('\nusage: RADIUS_PRIVATE_KEY=0x… node swap.mjs <amount> [source_chain source_token destination_chain destination_token] [destination_address]');
    process.exit(0);
  }
  if (!env.signer) {
    console.error('set RADIUS_PRIVATE_KEY (the wallet holding the source token and source-chain gas)');
    process.exit(1);
  }
  const account = privateKeyToAccount(env.signer);
  const [amount, sourceChain = 'base_sepolia', sourceToken = 'SBC', destinationChain = 'radius_testnet', destinationToken = 'SBC', destinationAddress] = args;
  const intent = { sourceChain, sourceToken, destinationChain, destinationToken, amount, destinationAddress };
  const route = await swap.route(intent);
  console.error(`${describeRoute(route)}\nfrom ${account.address}: ${amount} ${sourceToken} → ${destinationAddress ?? account.address}`);

  // Step by step (swap.swap(intent, account) does the same in one call).
  const prepared = await swap.prepare(intent, account);
  console.error(`prepared: deposit ${prepared.amount} ${prepared.depositToken} to ${prepared.depositAddress}; transaction expires ${prepared.preparedTxExpiresAt.toISOString()}`);
  const signed = await swap.signPrepared(prepared, account);            // signs unsigned_tx exactly as returned
  const broadcast = await swap.broadcast(prepared.swapToken, signed);
  console.error(`broadcast: session ${broadcast.sessionId}, source tx ${broadcast.txHash}, status ${broadcast.status}`);

  let status;
  if (process.env.SWAP_WAIT !== '0') {
    status = await swap.waitForCompletion(broadcast.swapToken, {
      untilPayout: true,
      timeoutMs: 15 * 60_000,
      onStatus: (s) => console.error(`  ${new Date().toISOString()} ${s.status}${s.payoutTx ? ` payout ${s.payoutTx}` : ''}`),
    });
    if (status.status !== 'complete') {
      console.error(`swap ${status.status}${status.error ? `: [${status.error.code}] ${status.error.message}` : ''}`);
      process.exitCode = 2;
    }
  }
  console.log(JSON.stringify({ sessionId: broadcast.sessionId, txHash: broadcast.txHash, status: status?.status ?? broadcast.status, payoutTx: status?.payoutTx, statusToken: broadcast.swapToken }, null, 2));
} catch (e) {
  if (e instanceof SwapError) {
    console.error(`swap error [${e.swapCode}] ${e.message}`);
    if (e.retryAfterMs) console.error(`retry after ${Math.ceil(e.retryAfterMs / 1000)} s`);
    process.exit(2);
  }
  throw e;
}
