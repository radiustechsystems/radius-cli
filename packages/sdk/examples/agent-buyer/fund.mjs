// Drips from the Radius faucet into a wallet and prints the faucet's view of it before and after.
//   RADIUS_PRIVATE_KEY=0x… node fund.mjs            drip into the key's address (can sign if the faucet asks)
//   node fund.mjs 0x<address>                        drip into any address, unsigned only
// RADIUS_NETWORK (default testnet) selects the faucet; RADIUS_FAUCET_URL overrides its URL.
import { privateKeyToAccount } from 'viem/accounts';
import { createFaucetClient, FaucetError } from 'radius-sdk/faucet';
import { radiusEnv } from 'radius-sdk';

const env = radiusEnv({ RADIUS_NETWORK: 'testnet', ...process.env });
const account = env.signer ? privateKeyToAccount(env.signer) : undefined;
const address = process.argv[2] ?? account?.address;
if (!address) {
  console.error('usage: RADIUS_PRIVATE_KEY=0x… node fund.mjs   |   node fund.mjs 0x<address>');
  process.exit(1);
}

const faucet = createFaucetClient({ network: env.network, faucetUrl: env.faucetUrl });
console.error(`faucet ${faucet.url} (${faucet.token}) → ${address}`);

const show = (s) => `${s.dripAmount ?? '?'} ${s.token} per drip; ${s.rateLimited ? `rate limited, retry in ${Math.ceil((s.retryAfterMs ?? 0) / 1000)} s` : `${s.remainingRequests ?? '?'} requests left`}`;
try {
  console.error(`before: ${show(await faucet.status(address))}`);
  // Unsigned drip; if the faucet answers signature_required and we hold the key, the SDK fetches
  // the challenge, signs it (EIP-191) and drips again. Without the key that case throws signer_required.
  const drip = await faucet.fund(address, { signer: account });
  console.log(JSON.stringify({ address: drip.address, token: drip.token, amount: drip.amount, txHash: drip.txHash, explorerUrl: drip.explorerUrl }, null, 2));
  console.error(`after:  ${show(await faucet.status(address))}`);
} catch (e) {
  if (e instanceof FaucetError) {
    console.error(`faucet error [${e.faucetCode}] ${e.message}`);
    if (e.retryAfterMs) console.error(`retry after ${Math.ceil(e.retryAfterMs / 1000)} s`);
    process.exit(2);
  }
  throw e;
}
