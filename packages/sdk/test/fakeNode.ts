/**
 * An in-memory JSON-RPC node behind a viem `custom` transport, enough for reads (`eth_call`),
 * event queries (`eth_getLogs`) and the full local-account write path viem takes
 * (`eth_getTransactionCount` → fee lookup → `eth_estimateGas` → `eth_sendRawTransaction` →
 * `eth_getTransactionReceipt`). Raw transactions are decoded so tests can assert on `to` and
 * calldata. `eth_call` and `eth_getLogs` are delegated to the test through `onCall` / `onLogs`.
 */
import { custom, keccak256, numberToHex, parseTransaction, type Address, type Hex } from 'viem';

export interface SentTx {
  to?: Address;
  data?: Hex;
  value?: bigint;
  hash: Hex;
}

export interface FakeNodeOptions {
  chainId: number;
  /** Answer an `eth_call`; return the hex result or throw. */
  onCall?: (tx: { to?: Address; data?: Hex; from?: Address }, block: unknown) => Hex | Promise<Hex>;
  /** Answer an `eth_getLogs`. */
  onLogs?: (filter: Record<string, unknown>) => unknown[];
  /** Receipt status for sent transactions. */
  status?: 'success' | 'reverted';
  /** Block number reported by `eth_blockNumber` / receipts. */
  blockNumber?: bigint;
  /** Advance the block number on every `eth_blockNumber` (so block watchers fire). */
  advanceBlocks?: boolean;
  /** Widest `toBlock - fromBlock` accepted by `eth_getLogs`, like a Radius node (default 1_000_000). */
  maxLogRange?: bigint;
}

export function fakeNode(opts: FakeNodeOptions) {
  const calls: { method: string; params: unknown[] }[] = [];
  const sent: SentTx[] = [];
  let blockNumber = opts.blockNumber ?? 1_700_000_000_000n;
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []) as never[];
        calls.push({ method, params: p });
        switch (method) {
          case 'eth_chainId':
            return numberToHex(opts.chainId);
          case 'eth_blockNumber':
            if (opts.advanceBlocks) blockNumber += 1n;
            return numberToHex(blockNumber);
          case 'eth_getTransactionCount':
            return numberToHex(sent.length);
          case 'eth_gasPrice':
            return numberToHex(986_000_000n);
          case 'eth_maxPriorityFeePerGas':
            return '0x0';
          case 'eth_getBlockByNumber':
            // No baseFeePerGas: viem falls back to legacy gasPrice transactions, as radius-cli sends.
            return { number: numberToHex(blockNumber), hash: numberToHex(blockNumber, { size: 32 }), timestamp: numberToHex(blockNumber / 1000n), transactions: [], baseFeePerGas: null };
          case 'eth_estimateGas':
            return numberToHex(60_000n);
          case 'eth_call': {
            if (!opts.onCall) throw new Error('eth_call not stubbed');
            return opts.onCall(p[0], p[1]);
          }
          case 'eth_getLogs': {
            const f = p[0] as { fromBlock?: unknown; toBlock?: unknown };
            const bound = (v: unknown) => (typeof v === 'string' && v.startsWith('0x') ? BigInt(v) : blockNumber);
            if (bound(f.toBlock) - bound(f.fromBlock) > (opts.maxLogRange ?? 1_000_000n)) {
              throw Object.assign(new Error('Block parameter could not be parsed as numeric or is not supported: block range is too wide'), { code: -33002 });
            }
            return opts.onLogs ? opts.onLogs(p[0] as Record<string, unknown>) : [];
          }
          case 'eth_sendRawTransaction': {
            const raw = p[0] as Hex;
            const tx = parseTransaction(raw);
            const hash = keccak256(raw);
            sent.push({ to: tx.to ?? undefined, data: tx.data, value: tx.value, hash });
            return hash;
          }
          case 'eth_getTransactionReceipt': {
            const hash = p[0] as Hex;
            const tx = sent.find((t) => t.hash === hash);
            if (!tx) return null;
            return {
              transactionHash: hash,
              transactionIndex: '0x0',
              blockHash: numberToHex(blockNumber, { size: 32 }),
              blockNumber: numberToHex(blockNumber),
              from: '0x0000000000000000000000000000000000000000',
              to: tx.to ?? null,
              cumulativeGasUsed: '0xea60',
              gasUsed: '0xea60',
              effectiveGasPrice: numberToHex(986_000_000n),
              contractAddress: null,
              logs: [],
              logsBloom: `0x${'0'.repeat(512)}`,
              status: (opts.status ?? 'success') === 'success' ? '0x1' : '0x0',
              type: '0x0',
            };
          }
          default:
            throw new Error(`fakeNode: unexpected RPC method ${method}`);
        }
      },
    },
    { retryCount: 0 },
  );
  return { transport, calls, sent, methods: () => calls.map((c) => c.method), setBlockNumber: (n: bigint) => { blockNumber = n; }, blockNumber: () => blockNumber };
}
