/**
 * Balance queries. The JSON-RPC side is a viem `custom` transport backed by an in-memory
 * "node" that models Radius: `eth_getBalance` answers native + SBC (1:1, rescaled to 18
 * decimals) while the EVM `BALANCE` opcode answers native only. The init code sent for the
 * raw native balance is also executed for real in @ethereumjs/evm to pin its semantics.
 */
import { createEVM } from '@ethereumjs/evm';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { createAccount, createAddressFromString, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { createClient, createPublicClient, custom, decodeFunctionData, encodeAbiParameters, numberToHex, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { defaultTokens, getAggregateBalance, getBalances, getNativeBalance, getTokenBalance, nativeBalanceBytecode, radiusActions, type BalanceToken } from '../src/balances.js';
import { radiusMainnet, radiusTestnet, SBC } from '../src/networks.js';

const OWNER = '0x4f2d8a3b1c0e5d9b8e7a6c5d4e3f2a1b0c9d8e7f' as Address;
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const USDX: BalanceToken = { address: OTHER_TOKEN, symbol: 'USDX', decimals: 18 };
const ERC20 = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const WEI = 10n ** 18n;
const SBC_TO_WEI = 10n ** 12n;

interface NodeState {
  native: bigint;
  sbc: bigint;
  usdx?: bigint;
  /** Reject `eth_call` with no `to` (a node that cannot run init code). */
  rejectInitCode?: boolean;
  /** Answer `eth_call` with no `to` with this instead of a word. */
  initCodeResult?: Hex;
}

/** A fake Radius node behind a viem transport, recording every request. */
function fakeNode(state: NodeState) {
  const calls: { method: string; params: unknown[] }[] = [];
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push({ method, params: params ?? [] });
      const p = (params ?? []) as [Record<string, unknown> & { to?: Address; data?: Hex }, string];
      switch (method) {
        case 'eth_chainId':
          return numberToHex(radiusTestnet.chainId);
        case 'eth_getBalance': {
          if (String(p[0]).toLowerCase() !== OWNER.toLowerCase()) return '0x0';
          return numberToHex(state.native + state.sbc * SBC_TO_WEI);
        }
        case 'eth_call': {
          const tx = p[0];
          if (!tx.to) {
            if (state.rejectInitCode) throw new Error('missing field `to`');
            if (state.initCodeResult !== undefined) return state.initCodeResult;
            expect(tx.data).toBe(nativeBalanceBytecode(OWNER));
            return numberToHex(state.native, { size: 32 });
          }
          const { args } = decodeFunctionData({ abi: ERC20, data: tx.data! });
          expect(args[0].toLowerCase()).toBe(OWNER.toLowerCase());
          if (tx.to.toLowerCase() === SBC.address.toLowerCase()) return encodeAbiParameters([{ type: 'uint256' }], [state.sbc]);
          if (tx.to.toLowerCase() === OTHER_TOKEN.toLowerCase()) return encodeAbiParameters([{ type: 'uint256' }], [state.usdx ?? 0n]);
          throw new Error(`unexpected eth_call to ${tx.to}`);
        }
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    },
    },
    { retryCount: 0 },
  );
  return { transport, calls };
}

describe('nativeBalanceBytecode', () => {
  it('is PUSH20 <addr> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN', () => {
    expect(nativeBalanceBytecode(OWNER)).toBe(`0x73${OWNER.slice(2).toLowerCase()}3160005260206000f3`);
    expect(() => nativeBalanceBytecode('0x1234' as Address)).toThrow(/not an address/);
  });

  it('returns the raw native balance when executed as init code by a real EVM', async () => {
    const sm = new SimpleStateManager();
    await sm.putAccount(createAddressFromString(OWNER), createAccount({ balance: 123_456_789n }));
    const evm = await createEVM({ stateManager: sm });
    const r = await evm.runCall({ data: hexToBytes(nativeBalanceBytecode(OWNER)), gasLimit: 100_000n });
    expect(r.execResult.exceptionError).toBeUndefined();
    expect(BigInt(bytesToHex(r.execResult.returnValue))).toBe(123_456_789n);
    // An account the EVM has never seen reads as zero rather than failing.
    const empty = await evm.runCall({ data: hexToBytes(nativeBalanceBytecode(OTHER_TOKEN)), gasLimit: 100_000n });
    expect(BigInt(bytesToHex(empty.execResult.returnValue))).toBe(0n);
  });
});

describe('getNativeBalance / getAggregateBalance / getTokenBalance', () => {
  it('separate what eth_getBalance aggregates', async () => {
    const node = fakeNode({ native: 2n * WEI, sbc: 10_000_000n });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    expect(await getNativeBalance(client, { address: OWNER })).toBe(2n * WEI);
    expect(await getAggregateBalance(client, { address: OWNER })).toBe(12n * WEI);
    expect(await client.getBalance({ address: OWNER })).toBe(12n * WEI);
    expect(await getTokenBalance(client, { address: OWNER, token: SBC })).toEqual({
      address: SBC.address,
      symbol: 'SBC',
      decimals: 6,
      convertible: true,
      atomic: 10_000_000n,
      formatted: '10',
    });
    expect((await getTokenBalance(client, { address: OWNER, token: USDX })).convertible).toBe(false);
    expect((await getTokenBalance(client, { address: OWNER, token: { ...USDX, convertible: true } })).convertible).toBe(true);
  });

  it('sends the native read as an eth_call with no `to` at the requested block', async () => {
    const node = fakeNode({ native: 5n, sbc: 0n });
    const client = createClient({ transport: node.transport });
    await getNativeBalance(client, { address: OWNER });
    await getNativeBalance(client, { address: OWNER, blockTag: 'pending' });
    await getNativeBalance(client, { address: OWNER, blockNumber: 1_700_000_000_000n });
    const ethCalls = node.calls.filter((c) => c.method === 'eth_call');
    expect(ethCalls.map((c) => c.params[1])).toEqual(['latest', 'pending', numberToHex(1_700_000_000_000n)]);
    for (const c of ethCalls) expect(c.params[0]).toEqual({ data: nativeBalanceBytecode(OWNER) });
  });

  it('rejects a node that does not answer with a 32-byte word', async () => {
    const node = fakeNode({ native: 5n, sbc: 0n, initCodeResult: '0x' });
    const client = createClient({ transport: node.transport });
    await expect(getNativeBalance(client, { address: OWNER })).rejects.toThrow(/instead of a 32-byte word/);
  });
});

describe('getBalances', () => {
  it('reports native, per-token and aggregate balances separately', async () => {
    const node = fakeNode({ native: 2_345_678n * 10n ** 12n, sbc: 10_000_000n });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    const b = await getBalances(client, { address: OWNER });
    expect(b.address).toBe(OWNER);
    expect(b.native).toEqual({
      symbol: 'RUSD',
      decimals: 18,
      raw: 2_345_678n * 10n ** 12n,
      rawFormatted: '2.345678',
      aggregate: 12_345_678n * 10n ** 12n,
      aggregateFormatted: '12.345678',
      convertible: 10n * WEI,
      convertibleFormatted: '10',
      rawSource: 'evm',
    });
    expect(b.tokens).toEqual([{ address: SBC.address, symbol: 'SBC', decimals: 6, convertible: true, atomic: 10_000_000n, formatted: '10' }]);
    expect(b.total).toBe(b.native.aggregate);
    expect(b.totalFormatted).toBe('12.345678');
    // One eth_getBalance, one eth_call per token, one eth_call for the native balance.
    expect(node.calls.filter((c) => c.method === 'eth_getBalance')).toHaveLength(1);
    expect(node.calls.filter((c) => c.method === 'eth_call')).toHaveLength(2);
  });

  it('includes extra tokens in total but not in the convertible amount', async () => {
    const node = fakeNode({ native: WEI, sbc: 1_000_000n, usdx: 3n * WEI });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    const b = await getBalances(client, { address: OWNER, tokens: [SBC, USDX] });
    expect(b.tokens.map((t) => [t.symbol, t.atomic, t.convertible])).toEqual([['SBC', 1_000_000n, true], ['USDX', 3n * WEI, false]]);
    expect(b.native.raw).toBe(WEI);
    expect(b.native.aggregate).toBe(2n * WEI);
    expect(b.native.convertible).toBe(WEI);
    expect(b.total).toBe(5n * WEI);
  });

  it('falls back to subtracting convertible tokens when the node cannot run init code', async () => {
    const node = fakeNode({ native: 3n * WEI, sbc: 2_500_000n, rejectInitCode: true });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    const b = await getBalances(client, { address: OWNER });
    expect(b.native.raw).toBe(3n * WEI);
    expect(b.native.rawFormatted).toBe('3');
    expect(b.native.aggregate).toBe(55n * 10n ** 17n);
    expect(b.native.convertible).toBe(25n * 10n ** 17n);
    expect(b.native.rawSource).toBe('derived');
    expect(b.native.rawError).toMatch(/missing field `to`/);
  });

  it("nativeBalance: 'evm' propagates the failure instead", async () => {
    const node = fakeNode({ native: 3n * WEI, sbc: 0n, rejectInitCode: true });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    await expect(getBalances(client, { address: OWNER, nativeBalance: 'evm' })).rejects.toThrow(/missing field `to`/);
  });

  it("nativeBalance: 'derived' skips the EVM read and clamps at zero", async () => {
    // A node whose aggregate is below the token value (rate drift) must not yield a negative native balance.
    const node = fakeNode({ native: 0n, sbc: 1_000_000n });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    const b = await getBalances(client, { address: OWNER, nativeBalance: 'derived', tokens: [SBC, { ...USDX, convertible: true }] });
    expect(node.calls.filter((c) => c.method === 'eth_call' && !(c.params[0] as { to?: string }).to)).toHaveLength(0);
    expect(b.native.rawSource).toBe('derived');
    expect(b.native.raw).toBe(0n);
    expect(b.native.rawError).toBeUndefined();

    const drift = fakeNode({ native: 0n, sbc: 0n });
    const c2 = createPublicClient({ chain: radiusTestnet.chain, transport: drift.transport });
    drift.calls.length = 0;
    const b2 = await getBalances(c2, { address: OWNER, nativeBalance: 'derived', tokens: [{ ...SBC, decimals: 6 }] });
    expect(b2.native.raw).toBe(0n);
    expect(b2.native.convertible).toBe(0n);
  });

  it('picks default tokens from the network, the client chain, or SBC', () => {
    const t = createClient({ chain: radiusTestnet.chain, transport: fakeNode({ native: 0n, sbc: 0n }).transport });
    const m = createClient({ chain: radiusMainnet.chain, transport: fakeNode({ native: 0n, sbc: 0n }).transport });
    const bare = createClient({ transport: fakeNode({ native: 0n, sbc: 0n }).transport });
    expect(defaultTokens(t)).toEqual([{ address: SBC.address, symbol: 'SBC', decimals: 6, convertible: true }]);
    expect(defaultTokens(m)[0].address).toBe(radiusMainnet.asset.address);
    expect(defaultTokens(bare)[0].address).toBe(SBC.address);
    expect(defaultTokens(bare, { chainId: 4242, rpcUrl: 'http://rpc', facilitatorUrl: 'http://f', asset: { address: OTHER_TOKEN, symbol: 'USDX', decimals: 18 } })).toEqual([
      { address: OTHER_TOKEN, symbol: 'USDX', decimals: 18, convertible: true },
    ]);
  });

  it('uses the native currency of the client chain when formatting', async () => {
    const node = fakeNode({ native: 7n * WEI, sbc: 0n });
    const client = createClient({ transport: node.transport }); // no chain: RUSD/18 assumed
    const b = await getBalances(client, { address: OWNER, tokens: [] });
    expect(b.native.symbol).toBe('RUSD');
    expect(b.native.rawFormatted).toBe('7');
    expect(b.tokens).toEqual([]);
    expect(b.total).toBe(7n * WEI);
  });
});

describe('radiusActions', () => {
  it('extends a viem client with the balance actions', async () => {
    const node = fakeNode({ native: WEI, sbc: 4_000_000n, usdx: 2n * WEI });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport }).extend(radiusActions());
    expect(await client.getNativeBalance({ address: OWNER })).toBe(WEI);
    expect(await client.getAggregateBalance({ address: OWNER })).toBe(5n * WEI);
    expect(await client.getBalance({ address: OWNER })).toBe(5n * WEI);
    expect((await client.getTokenBalance({ address: OWNER, token: SBC })).atomic).toBe(4_000_000n);
    const b = await client.getBalances({ address: OWNER });
    expect(b.native.raw).toBe(WEI);
    expect(b.tokens.map((t) => t.symbol)).toEqual(['SBC']);
  });

  it('takes default tokens from its config, overridable per call', async () => {
    const node = fakeNode({ native: WEI, sbc: 4_000_000n, usdx: 2n * WEI });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport }).extend(radiusActions({ tokens: [SBC, USDX] }));
    expect((await client.getBalances({ address: OWNER })).tokens.map((t) => t.symbol)).toEqual(['SBC', 'USDX']);
    expect((await client.getBalances({ address: OWNER, tokens: [USDX] })).tokens.map((t) => t.symbol)).toEqual(['USDX']);
  });
});
