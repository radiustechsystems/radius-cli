// Run after building the workspace. Buys at most one resource on Radius or Base.
// Set BUYER_PRIVATE_KEY via your secret store, PAID_URL and EXPECTED_PAY_TO explicitly.
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { radiusMainnet, SBC } from 'radius-sdk';
import { createEvmFetch } from 'radius-sdk/client';

const { BUYER_PRIVATE_KEY, PAID_URL, EXPECTED_PAY_TO } = process.env;
if (!BUYER_PRIVATE_KEY || !PAID_URL || !EXPECTED_PAY_TO) {
  throw new Error('Set BUYER_PRIVATE_KEY, PAID_URL and EXPECTED_PAY_TO to run this paid example');
}
const pay = createEvmFetch({
  signer: privateKeyToAccount(BUYER_PRIVATE_KEY),
  networks: [
    { chain: radiusMainnet.chain, assets: [{ asset: SBC, maxPerRequest: '0.05' }] },
    { chain: base, assets: [{
      asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, name: 'USD Coin', version: '2' },
      maxPerRequest: '0.05',
    }] },
  ],
  onPaymentRequired: offer => offer.payTo.toLowerCase() === EXPECTED_PAY_TO.toLowerCase(),
  onPaid: (receipt, offer) => console.log({ network: offer.network, asset: offer.asset, receipt }),
});
const response = await pay(PAID_URL);
console.log({ status: response.status, body: await response.text() });
