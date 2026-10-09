#!/usr/bin/env node
/** Reference decision adapter for the agent evaluation protocol. */
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { offer, policy, previousOutcome, url } = JSON.parse(input);
let decision = 'buy';
if (previousOutcome === 'unknown') decision = 'reconcile';
else if (offer.network !== policy.network || offer.asset.toLowerCase() !== policy.asset.toLowerCase() ||
  offer.payTo.toLowerCase() !== policy.payTo.toLowerCase() ||
  BigInt(offer.amount) > BigInt(policy.maxPerRequest) ||
  BigInt(policy.spent) + BigInt(offer.amount) > BigInt(policy.totalBudget)) decision = 'decline';
process.stdout.write(`${JSON.stringify({ decision, selectedUrl: url })}\n`);
