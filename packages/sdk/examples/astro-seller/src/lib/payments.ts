import { radiusPayments } from 'radius-sdk/server';

const PAY_TO = (import.meta.env.PAY_TO ?? '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE') as `0x${string}`;
const NETWORK = (import.meta.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';

export const pay = radiusPayments({
  network: NETWORK,
  payTo: PAY_TO,
  routes: { 'GET /articles/*': { price: '$0.001', description: 'One article' } },
  onSettled: (receipt, request) => console.log('settled', receipt.transaction, receipt.payer, new URL(request.url).pathname),
});
