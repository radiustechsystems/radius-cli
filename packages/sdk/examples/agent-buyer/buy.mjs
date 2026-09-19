// Buys one paid lookup from the seller worker and prints the receipt.
// Usage: RADIUS_PRIVATE_KEY=0x… node buy.mjs [url]
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from 'radius-sdk/client';

const url = process.argv[2] ?? 'http://localhost:8787/api/lookup?ip=1.2.3.4';
const key = process.env.RADIUS_PRIVATE_KEY;
if (!key) {
  console.error('set RADIUS_PRIVATE_KEY');
  process.exit(1);
}

const payFetch = createRadiusFetch({
  network: process.env.RADIUS_NETWORK ?? 'testnet',
  signer: key,
  maxPerRequest: '$0.01',
  onPaymentRequired: (offer) => {
    console.error(`offer: ${offer.amountFormatted} → ${offer.payTo} for ${offer.resource.url}`);
    return true;
  },
});

// balances() reports SBC and native RUSD separately (eth_getBalance alone would blend them).
const { native, tokens: [sbc] } = await payFetch.balances();
console.error(`payer ${payFetch.address}, balance ${sbc.formatted} ${sbc.symbol} + ${native.rawFormatted} ${native.symbol}`);
try {
  const res = await payFetch(url);
  console.error(`HTTP ${res.status}`);
  console.log(await res.text());
  console.error('receipt:', getPaymentReceipt(res, payFetch.network));
} catch (e) {
  if (e instanceof RadiusPaymentError) console.error(`payment error [${e.code}]: ${e.message}`);
  else throw e;
  process.exit(2);
}
