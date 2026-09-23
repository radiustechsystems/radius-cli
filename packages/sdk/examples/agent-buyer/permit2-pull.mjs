// Permit2 SignatureTransfer end to end, outside of x402: a payer signs a one-off permit
// off-chain and a collector pulls the SBC with it. This is the primitive x402 `exact`
// (Permit2) payments are built on; here the collector is a plain account, not the x402 proxy.
//
// Usage: RADIUS_PRIVATE_KEY=<payer key> COLLECTOR_PRIVATE_KEY=<collector key> node permit2-pull.mjs [amount]
//   The payer needs SBC plus a one-time Permit2 approval (sent here if missing; gas comes from
//   SBC via Turnstile). The collector pays gas for the pull, so it needs a little SBC too.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Actions, formatTokenAmount, permit2Actions, radiusActions } from 'radius-sdk/client';
import { SBC, radiusTestnet } from 'radius-sdk';

const amount = process.argv[2] ?? '0.001';
const payer = createWalletClient({ account: privateKeyToAccount(process.env.RADIUS_PRIVATE_KEY), chain: radiusTestnet.chain, transport: http() })
  .extend(radiusActions()).extend(erc20Actions()).extend(permit2Actions());
const collector = createWalletClient({ account: privateKeyToAccount(process.env.COLLECTOR_PRIVATE_KEY), chain: radiusTestnet.chain, transport: http() })
  .extend(radiusActions()).extend(permit2Actions());

// 1. One-time: the payer lets Permit2 move its SBC (unlimited, the x402 "one-time gas approval" model).
if ((await payer.getPermit2Approval({ owner: payer.account.address })) < 10n ** 12n) {
  const tx = await payer.approvePermit2();
  console.error(`payer approved Permit2 in ${tx.hash} (${tx.status})`);
}

// 2. Off-chain: the payer signs a permit for the collector. Nothing is sent; `signed` is plain JSON-able data.
const signed = await payer.signPermit2Transfer({ amount, spender: collector.account.address });
console.error(`payer ${payer.account.address} signed a permit for ${formatTokenAmount(signed.permit.permitted.amount, SBC)} to spender ${signed.spender}, nonce ${signed.permit.nonce}, deadline ${signed.permit.deadline}`);
console.error(`nonce used before pull: ${await collector.isPermit2NonceUsed({ owner: signed.owner, nonce: signed.permit.nonce })}`);

// 3. On-chain: the collector pulls the SBC to itself. It could also pull less than the permitted amount.
const before = (await collector.getTokenBalance({ address: collector.account.address, token: SBC })).atomic;
const pull = await collector.permit2TransferFrom({ signed, to: collector.account.address });
const after = (await collector.getTokenBalance({ address: collector.account.address, token: SBC })).atomic;
console.error(`collector pulled ${formatTokenAmount(after - before, SBC)} in ${pull.hash} (${pull.status}) ${pull.explorerUrl ?? ''}`);
console.error(`nonce used after pull: ${await collector.isPermit2NonceUsed({ owner: signed.owner, nonce: signed.permit.nonce })}`);
