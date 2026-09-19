// Proves the gasless path: a brand-new wallet with only SBC (no RUSD, no Permit2
// approval) pays a lookup; the facilitator sponsors the EIP-2612 permit.
// The fresh wallet is funded from the testnet faucet (no funder key needed), or with
// 0.005 SBC transferred from RADIUS_PRIVATE_KEY when that is set.
// Usage: [RADIUS_PRIVATE_KEY=<funded key>] node fresh-wallet.mjs [url]
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, getPaymentReceipt, radiusActions } from 'radius-sdk/client';
import { createFaucetClient } from 'radius-sdk/faucet';
import { PERMIT2_ADDRESS, SBC, formatAmount, radiusTestnet } from 'radius-sdk';

const url = process.argv[2] ?? 'http://localhost:8787/api/lookup?ip=9.9.9.9';
const freshKey = generatePrivateKey();
const fresh = privateKeyToAccount(freshKey);
const chain = radiusTestnet.chain;   // the SDK network's viem Chain (id, RPC, explorer)
// radiusActions() adds getBalances(): on Radius eth_getBalance is native RUSD *plus* SBC at 1:1,
// so a wallet holding only SBC still shows a non-zero eth_getBalance. getBalances() splits them.
const pub = createPublicClient({ chain, transport: http() }).extend(radiusActions());
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function allowance(address,address) view returns (uint256)']);

if (process.env.RADIUS_PRIVATE_KEY) {
  const funder = privateKeyToAccount(process.env.RADIUS_PRIVATE_KEY);
  const wallet = createWalletClient({ chain, transport: http(), account: funder });
  console.error(`fresh wallet ${fresh.address}; funding 0.005 SBC from ${funder.address}`);
  const hash = await wallet.writeContract({ address: SBC.address, abi: erc20, functionName: 'transfer', args: [fresh.address, 5000n] });
  await pub.waitForTransactionReceipt({ hash });
} else {
  // Faucet drip (~0.5 SBC on testnet). Unsigned first; signs the EIP-191 challenge only if the faucet asks.
  const faucet = createFaucetClient({ network: radiusTestnet });
  console.error(`fresh wallet ${fresh.address}; dripping from ${faucet.url}`);
  const drip = await faucet.fund(fresh.address, { signer: fresh });
  console.error(`faucet dripped ${drip.amount} ${drip.token}: ${drip.explorerUrl ?? drip.txHash}`);
  if (drip.txHash) await pub.waitForTransactionReceipt({ hash: drip.txHash });
}
const { native, tokens: [sbcBefore] } = await pub.getBalances({ address: fresh.address });
const before = sbcBefore.atomic;
const allowance = await pub.readContract({ address: SBC.address, abi: erc20, functionName: 'allowance', args: [fresh.address, PERMIT2_ADDRESS] });
console.error(`before: SBC ${sbcBefore.formatted}, native RUSD ${native.rawFormatted} (eth_getBalance reports ${native.aggregateFormatted}: SBC counted 1:1), Permit2 allowance ${allowance}`);

const payFetch = createRadiusFetch({ network: 'testnet', signer: freshKey, maxPerRequest: '$0.01' });
const res = await payFetch(url);
console.error(`HTTP ${res.status}`);
console.log(await res.text());
console.error('receipt:', getPaymentReceipt(res, payFetch.network));

const after = (await pub.getTokenBalance({ address: fresh.address, token: SBC })).atomic;
const allowanceAfter = await pub.readContract({ address: SBC.address, abi: erc20, functionName: 'allowance', args: [fresh.address, PERMIT2_ADDRESS] });
console.error(`after: SBC ${formatAmount(after, 6)} (spent ${formatAmount(before - after, 6)}), Permit2 allowance ${allowanceAfter === (2n ** 256n - 1n) ? 'MaxUint256' : allowanceAfter}`);
