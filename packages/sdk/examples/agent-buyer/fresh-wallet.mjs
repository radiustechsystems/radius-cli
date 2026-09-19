// Proves the gasless path: a brand-new wallet with only SBC (no RUSD, no Permit2
// approval) pays a lookup; the facilitator sponsors the EIP-2612 permit.
// Usage: RADIUS_PRIVATE_KEY=<funded key> node fresh-wallet.mjs [url]
import { createPublicClient, createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, getPaymentReceipt } from 'radius-sdk/client';
import { SBC, erc20Actions, formatAmount, permit2Actions, radiusActions, radiusTestnet } from 'radius-sdk';

const url = process.argv[2] ?? 'http://localhost:8787/api/lookup?ip=9.9.9.9';
const funder = privateKeyToAccount(process.env.RADIUS_PRIVATE_KEY);
const freshKey = generatePrivateKey();
const fresh = privateKeyToAccount(freshKey);
const chain = radiusTestnet.chain;   // the SDK network's viem Chain (id, RPC, explorer)
// radiusActions() adds getBalances(): on Radius eth_getBalance is native RUSD *plus* SBC at 1:1,
// so a wallet holding only SBC still shows a non-zero eth_getBalance. getBalances() splits them.
// erc20Actions() adds transfer/approve/getAllowance/… for SBC (the default token on Radius networks);
// permit2Actions() adds the Permit2 reads (getPermit2Approval = the ERC-20 allowance granted to Permit2).
const pub = createPublicClient({ chain, transport: http() }).extend(radiusActions()).extend(erc20Actions()).extend(permit2Actions());
const wallet = createWalletClient({ chain, transport: http(), account: funder }).extend(erc20Actions());

console.error(`fresh wallet ${fresh.address}; funding 0.005 SBC from ${funder.address}`);
const funded = await wallet.transfer({ to: fresh.address, amount: '0.005' });   // waits for the receipt
console.error(`funded in ${funded.hash} (${funded.status})`);
const { native, tokens: [sbcBefore] } = await pub.getBalances({ address: fresh.address });
const before = sbcBefore.atomic;
const allowance = await pub.getPermit2Approval({ owner: fresh.address });
console.error(`before: SBC ${sbcBefore.formatted}, native RUSD ${native.rawFormatted} (eth_getBalance reports ${native.aggregateFormatted}: SBC counted 1:1), Permit2 allowance ${allowance}`);

const payFetch = createRadiusFetch({ network: 'testnet', signer: freshKey, maxPerRequest: '$0.01' });
const res = await payFetch(url);
console.error(`HTTP ${res.status}`);
console.log(await res.text());
console.error('receipt:', getPaymentReceipt(res, payFetch.network));

const after = (await pub.getTokenBalance({ address: fresh.address, token: SBC })).atomic;
const allowanceAfter = await pub.getPermit2Approval({ owner: fresh.address });
console.error(`after: SBC ${formatAmount(after, 6)} (spent ${formatAmount(before - after, 6)}), Permit2 allowance ${allowanceAfter === (2n ** 256n - 1n) ? 'MaxUint256' : allowanceAfter}`);
