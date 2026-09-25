/**
 * A JSON-RPC node backed by a real EVM (@ethereumjs/evm) behind a viem `custom` transport, so
 * tests can prove state transitions rather than calldata: `eth_call` and `eth_estimateGas`
 * execute against a scratch copy of state, `eth_sendRawTransaction` recovers the sender,
 * checks the nonce, executes the transaction, mines it as its own block and stores a receipt
 * with the real status and logs, and `eth_getLogs` serves those logs with the same block-range
 * cap a Radius node enforces. Block numbers start at a unix-millisecond value like Radius.
 *
 * Gas is executed but never charged (no fee deduction, no intrinsic gas), so native balances
 * only move with `value`. The same `{ transport, calls, sent, methods() }` surface as fakeNode.
 */
import { createEVM, type EVMResult, type ExecResult } from '@ethereumjs/evm';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { bytesToHex, createAccount, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { custom, getAddress, keccak256, numberToHex, parseTransaction, recoverTransactionAddress, RpcRequestError, type Address, type Hex } from 'viem';

export interface SentTx {
  from: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  nonce: number;
  hash: Hex;
}

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: false;
}

interface LogFilter {
  address?: Hex | Hex[];
  topics?: (Hex | Hex[] | null)[];
  fromBlock?: Hex | string;
  toBlock?: Hex | string;
}

export interface EvmNodeOptions {
  chainId: number;
  /** Accounts funded with plenty of native balance (so `value` transfers and gas checks never fail). */
  accounts: Address[];
  /** Widest `toBlock - fromBlock` accepted by `eth_getLogs`, like a Radius node (default 1_000_000). */
  maxLogRange?: bigint;
  /** First block number (default: a unix-ms value, like Radius). */
  blockNumber?: bigint;
}

const rpcError = (method: string, params: unknown[], code: number, message: string, data?: Hex) =>
  new RpcRequestError({ body: { method, params }, url: 'evm://', error: { code, message, data } });

export async function evmNode(opts: EvmNodeOptions) {
  const sm = new SimpleStateManager();
  const evm = await createEVM({ stateManager: sm });
  const A = (a: string) => createAddressFromString(a);
  for (const a of opts.accounts) await sm.putAccount(A(a), createAccount({ balance: 10n ** 24n }));

  let blockNumber = opts.blockNumber ?? 1_700_000_000_000n;
  const maxLogRange = opts.maxLogRange ?? 1_000_000n;
  const calls: { method: string; params: unknown[] }[] = [];
  const sent: SentTx[] = [];
  const receipts = new Map<Hex, Record<string, unknown>>();
  const logs: RpcLog[] = [];

  const blockHashOf = (n: bigint) => numberToHex(n, { size: 32 });

  /** Mine one block holding `r`'s logs for transaction `hash`. */
  const mine = (hash: Hex, r: EVMResult): RpcLog[] => {
    blockNumber += 1n;
    const txLogs: RpcLog[] = (r.execResult.logs ?? []).map(([address, topics, data], i) => ({
      address: bytesToHex(address),
      topics: topics.map((t) => bytesToHex(t)),
      data: bytesToHex(data),
      blockNumber: numberToHex(blockNumber),
      blockHash: blockHashOf(blockNumber),
      transactionHash: hash,
      transactionIndex: '0x0',
      logIndex: numberToHex(i),
      removed: false,
    }));
    logs.push(...txLogs);
    return txLogs;
  };

  const revertError = (method: string, params: unknown[], r: ExecResult) =>
    rpcError(method, params, 3, `execution reverted (${r.exceptionError!.error})`, bytesToHex(r.returnValue));

  /** Execute without persisting anything (eth_call / eth_estimateGas). */
  const simulate = async (tx: { from?: Address; to?: Address; data?: Hex; value?: Hex }): Promise<EVMResult> => {
    await sm.checkpoint();
    try {
      return await evm.runCall({
        caller: tx.from ? A(tx.from) : undefined,
        to: tx.to ? A(tx.to) : undefined,
        data: tx.data ? hexToBytes(tx.data) : undefined,
        value: tx.value ? BigInt(tx.value) : 0n,
        gasLimit: 10_000_000n,
      });
    } finally {
      await sm.revert();
    }
  };

  /** Deploy a contract from `initCode` as `from`; the deployment is mined as its own block (with its logs). */
  const deploy = async (initCode: Hex, from: Address): Promise<Address> => {
    const r = await evm.runCall({ caller: A(from), data: hexToBytes(initCode), gasLimit: 10_000_000n });
    if (r.execResult.exceptionError) throw new Error(`deploy failed: ${r.execResult.exceptionError.error}`);
    mine(keccak256(initCode), r);
    return getAddress(r.createdAddress!.toString());
  };

  const inRange = (log: RpcLog, filter: LogFilter, method: string, params: unknown[]): boolean => {
    const bound = (v: Hex | string | undefined) => (typeof v === 'string' && v.startsWith('0x') ? BigInt(v) : blockNumber);
    const from = bound(filter.fromBlock);
    const to = bound(filter.toBlock);
    if (to - from > maxLogRange) throw rpcError(method, params, -33002, 'Block parameter could not be parsed as numeric or is not supported: block range is too wide');
    const n = BigInt(log.blockNumber);
    return n >= from && n <= to;
  };

  const matches = (log: RpcLog, filter: LogFilter): boolean => {
    if (filter.address) {
      const wanted = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
      if (!wanted.includes(log.address.toLowerCase())) return false;
    }
    for (const [i, want] of (filter.topics ?? []).entries()) {
      if (want === null || want === undefined) continue;
      const options = (Array.isArray(want) ? want : [want]).map((t) => t.toLowerCase());
      if (!options.includes((log.topics[i] ?? '').toLowerCase())) return false;
    }
    return true;
  };

  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []) as never[];
        calls.push({ method, params: p });
        switch (method) {
          case 'eth_chainId':
            return numberToHex(opts.chainId);
          case 'eth_blockNumber':
            return numberToHex(blockNumber);
          case 'eth_getTransactionCount':
            return numberToHex((await sm.getAccount(A(p[0])))?.nonce ?? 0n);
          case 'eth_getBalance':
            return numberToHex((await sm.getAccount(A(p[0])))?.balance ?? 0n);
          case 'eth_getCode':
            return bytesToHex(await sm.getCode(A(p[0])));
          case 'eth_gasPrice':
            return numberToHex(986_000_000n);
          case 'eth_maxPriorityFeePerGas':
            return '0x0';
          case 'eth_getBlockByNumber':
            // No baseFeePerGas: viem falls back to legacy gasPrice transactions, as on Radius.
            return { number: numberToHex(blockNumber), hash: blockHashOf(blockNumber), timestamp: numberToHex(blockNumber / 1000n), transactions: [], baseFeePerGas: null };
          case 'eth_call': {
            const r = await simulate(p[0]);
            if (r.execResult.exceptionError) throw revertError(method, p, r.execResult);
            return bytesToHex(r.execResult.returnValue);
          }
          case 'eth_estimateGas': {
            const r = await simulate(p[0]);
            if (r.execResult.exceptionError) throw revertError(method, p, r.execResult);
            return numberToHex(r.execResult.executionGasUsed * 2n + 21_000n);
          }
          case 'eth_sendRawTransaction': {
            const raw = p[0] as Hex;
            const tx = parseTransaction(raw);
            const hash = keccak256(raw);
            const from = await recoverTransactionAddress({ serializedTransaction: raw });
            const expected = (await sm.getAccount(A(from)))?.nonce ?? 0n;
            const nonce = BigInt(tx.nonce ?? 0);
            if (nonce !== expected) throw rpcError(method, p, -32000, `nonce too ${nonce < expected ? 'low' : 'high'}: expected ${expected}, got ${nonce}`);
            const r = await evm.runCall({
              caller: A(from),
              to: tx.to ? A(tx.to) : undefined,
              data: tx.data ? hexToBytes(tx.data) : undefined,
              value: tx.value ?? 0n,
              gasLimit: tx.gas ?? 10_000_000n,
            });
            const txLogs = mine(hash, r);
            sent.push({ from, to: tx.to ?? undefined, data: tx.data, value: tx.value, nonce: Number(nonce), hash });
            receipts.set(hash, {
              transactionHash: hash,
              transactionIndex: '0x0',
              blockHash: blockHashOf(blockNumber),
              blockNumber: numberToHex(blockNumber),
              from,
              to: tx.to ?? null,
              cumulativeGasUsed: numberToHex(r.execResult.executionGasUsed),
              gasUsed: numberToHex(r.execResult.executionGasUsed),
              effectiveGasPrice: numberToHex(986_000_000n),
              contractAddress: r.createdAddress ? getAddress(r.createdAddress.toString()) : null,
              logs: txLogs,
              logsBloom: `0x${'0'.repeat(512)}`,
              status: r.execResult.exceptionError ? '0x0' : '0x1',
              type: '0x0',
            });
            return hash;
          }
          case 'eth_getTransactionReceipt':
            return receipts.get(p[0] as Hex) ?? null;
          case 'eth_getLogs': {
            const filter = p[0] as LogFilter;
            return logs.filter((l) => inRange(l, filter, method, p) && matches(l, filter));
          }
          default:
            throw new Error(`evmNode: unexpected RPC method ${method}`);
        }
      },
    },
    { retryCount: 0 },
  );

  return {
    transport,
    deploy,
    calls,
    sent,
    logs,
    methods: () => calls.map((c) => c.method),
    blockNumber: () => blockNumber,
    /** Jump the head forward (as time passing would on Radius). */
    setBlockNumber: (n: bigint) => { blockNumber = n; },
    state: sm,
    evm,
  };
}
