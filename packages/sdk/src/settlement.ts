import { createPublicClient, http, parseAbiItem, parseEventLogs, type PublicClient } from 'viem';
import { explorerTxUrl, type Address, type PaymentNetwork } from './networks.js';
import { formatAmount } from './amounts.js';

export interface SettlementTransfer {
  from: Address;
  to: Address;
  /** Atomic units of the network's payment asset. */
  amount: bigint;
}

/** On-chain view of a settlement transaction, for reconciling receipts. */
export interface Settlement {
  transaction: `0x${string}`;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  /** Transfers of the payment asset that happened in this transaction. */
  transfers: SettlementTransfer[];
  /** Total of the payment asset that reached `to` (all transfers if omitted). */
  paid(to?: Address): bigint;
  paidFormatted(to?: Address): string;
  explorerUrl?: string;
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Look up a settlement transaction on-chain. Returns undefined while the
 * transaction is unknown to the node (not yet mined, or never existed).
 * Use it to reconcile a timed-out payment before authorising another charge.
 */
export async function getSettlement(network: PaymentNetwork, txHash: `0x${string}`, client?: PublicClient): Promise<Settlement | undefined> {
  const pc = client ?? createPublicClient({ chain: network.chain, transport: http(network.rpcUrl) });
  let receipt;
  try {
    receipt = await pc.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    if (e instanceof Error && /not (be )?found|could not be found/i.test(e.message)) return undefined;
    throw e;
  }
  if (!receipt) return undefined;
  const asset = network.asset.address.toLowerCase();
  const transfers = parseEventLogs({ abi: [TRANSFER], logs: receipt.logs, eventName: 'Transfer' })
    .filter((l) => l.address.toLowerCase() === asset)
    .map((l) => ({ from: l.args.from as Address, to: l.args.to as Address, amount: l.args.value as bigint }));
  const paid = (to?: Address) =>
    transfers.filter((t) => !to || t.to.toLowerCase() === to.toLowerCase()).reduce((sum, t) => sum + t.amount, 0n);
  return {
    transaction: txHash,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    transfers,
    paid,
    paidFormatted: (to?: Address) => formatAmount(paid(to), network.asset.decimals, network.asset.symbol),
    explorerUrl: explorerTxUrl(network, txHash),
  };
}
