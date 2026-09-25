import { createPublicClient, createWalletClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, maxUint256, numberToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { approve, erc20Actions, formatTokenAmount, getAllowance, getTokenMetadata, getTransfers, toTokenAtomic, transfer, transferFrom, watchTransfers } from '../src/erc20.js';
import { createRadiusFetch, type ApprovalRequest } from '../src/client/index.js';
import { defineRadiusNetwork, PERMIT2_ADDRESS, radiusMainnet, radiusTestnet, SBC } from '../src/networks.js';
import { RadiusPaymentError } from '../src/errors.js';
import { fakeNode } from './fakeNode.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const OWNER = privateKeyToAccount(PK);
const SPENDER = '0x000000000000000000000000000000000000dEaD' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const USDX: Address = '0x2222222222222222222222222222222222222222';

const word = (v: bigint | number) => numberToHex(BigInt(v), { size: 32 });
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

/** ERC-20 view answers for SBC (6 decimals) and USDX (18 decimals). */
function erc20Node() {
  return fakeNode({
    chainId: radiusTestnet.chainId,
    onCall: ({ to, data }) => {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: data! });
      const isSbc = to!.toLowerCase() === SBC.address.toLowerCase();
      switch (functionName) {
        case 'decimals': return word(isSbc ? 6 : 18);
        case 'name': return str(isSbc ? 'Stable Coin' : 'USDX Token');
        case 'symbol': return str(isSbc ? 'SBC' : 'USDX');
        case 'totalSupply': return word(1_000_000_000_000n);
        case 'allowance': {
          const [owner, spender] = args as [Address, Address];
          return word(isSbc && owner.toLowerCase() === OWNER.address.toLowerCase() && spender.toLowerCase() === SPENDER.toLowerCase() ? 42n : 0n);
        }
        default: throw new Error(`unexpected view ${functionName}`);
      }
    },
  });
}

const publicClient = (node = erc20Node()) => ({ node, client: createPublicClient({ chain: radiusTestnet.chain, transport: node.transport }) });
const walletClient = (node = erc20Node()) => ({ node, client: createWalletClient({ account: OWNER, chain: radiusTestnet.chain, transport: node.transport }) });

function decodeSent(node: ReturnType<typeof fakeNode>, i = 0) {
  const tx = node.sent[i];
  return { to: tx.to, ...decodeFunctionData({ abi: erc20Abi, data: tx.data! }) };
}

describe('toTokenAtomic', () => {
  it('passes bigints through and parses display strings with the token decimals', async () => {
    const { client, node } = publicClient();
    expect(await toTokenAtomic(client, SBC, 5n)).toBe(5n);
    expect(await toTokenAtomic(client, SBC, '1.5')).toBe(1_500_000n);
    expect(await toTokenAtomic(client, SBC, ' 0.000001 ')).toBe(1n);
    expect(node.methods()).not.toContain('eth_call'); // decimals known from the token object
    expect(await toTokenAtomic(client, USDX, '2')).toBe(2n * 10n ** 18n);
    expect(node.methods()).toContain('eth_call'); // bare address: decimals() read once
  });
  it('rejects negative, malformed and over-precise amounts', async () => {
    const { client } = publicClient();
    await expect(toTokenAtomic(client, SBC, -1n)).rejects.toBeInstanceOf(RadiusPaymentError);
    await expect(toTokenAtomic(client, SBC, '$1')).rejects.toThrow(/decimal string/);
    await expect(toTokenAtomic(client, SBC, '1.2345678')).rejects.toThrow(/more than 6 decimal places/);
  });
});

describe('reads', () => {
  it('getTokenMetadata reads name, symbol, decimals and totalSupply', async () => {
    const { client } = publicClient();
    expect(await getTokenMetadata(client)).toEqual({ address: SBC.address, name: 'Stable Coin', symbol: 'SBC', decimals: 6, totalSupply: 1_000_000_000_000n });
    expect(await getTokenMetadata(client, { token: USDX })).toMatchObject({ address: USDX, symbol: 'USDX', decimals: 18 });
  });
  it('getAllowance defaults the token to SBC', async () => {
    const { client } = publicClient();
    expect(await getAllowance(client, { owner: OWNER.address, spender: SPENDER })).toBe(42n);
    expect(await getAllowance(client, { owner: OWNER.address, spender: OTHER })).toBe(0n);
    expect(await getAllowance(client, { token: USDX, owner: OWNER.address, spender: SPENDER })).toBe(0n);
  });
  it('formatTokenAmount', () => {
    expect(formatTokenAmount(1_500_000n, SBC)).toBe('1.5 SBC');
  });
});

describe('writes', () => {
  it('approve sends approve(spender, amount) to the token and waits for the receipt', async () => {
    const { client, node } = walletClient();
    const r = await approve(client, { spender: SPENDER, amount: '2.5' });
    expect(r.status).toBe('success');
    expect(r.hash).toBe(node.sent[0].hash);
    expect(r.explorerUrl).toBe(`https://testnet.radiustech.xyz/tx/${r.hash}`);
    expect(decodeSent(node)).toEqual({ to: SBC.address.toLowerCase(), functionName: 'approve', args: [SPENDER, 2_500_000n] });
    expect(node.methods()).toContain('eth_getTransactionReceipt');
  });
  it('transfer and transferFrom encode their calls; wait: false skips the receipt', async () => {
    const { client, node } = walletClient();
    await transfer(client, { to: OTHER, amount: 7n });
    expect(decodeSent(node, 0)).toEqual({ to: SBC.address.toLowerCase(), functionName: 'transfer', args: [OTHER, 7n] });
    node.calls.length = 0;
    const r = await transferFrom(client, { token: USDX, from: OTHER, to: SPENDER, amount: '1', wait: false });
    expect(decodeSent(node, 1)).toEqual({ to: USDX, functionName: 'transferFrom', args: [OTHER, SPENDER, 10n ** 18n] });
    expect(r.status).toBe('pending');
    expect(r.explorerUrl).toBe(`https://testnet.radiustech.xyz/tx/${r.hash}`);
    expect(node.methods()).not.toContain('eth_getTransactionReceipt');
  });
  it('a gas limit is passed through and skips eth_estimateGas', async () => {
    const { client, node } = walletClient();
    expect((await transfer(client, { to: OTHER, amount: 1n, gas: 90_000n, wait: false })).status).toBe('pending');
    expect(node.methods()).not.toContain('eth_estimateGas');
    node.calls.length = 0;
    await approve(client, { spender: SPENDER, amount: 1n, wait: false });
    expect(node.methods()).toContain('eth_estimateGas');
  });
  it('reports a reverted receipt', async () => {
    const node = fakeNode({ chainId: radiusTestnet.chainId, status: 'reverted' });
    const client = createWalletClient({ account: OWNER, chain: radiusTestnet.chain, transport: node.transport });
    expect((await transfer(client, { to: OTHER, amount: 1n })).status).toBe('reverted');
  });
  it('needs an account', async () => {
    const { client } = publicClient();
    await expect(approve(client as never, { spender: SPENDER, amount: 1n })).rejects.toMatchObject({ code: 'config' });
    await expect(transfer(client as never, { to: OTHER, amount: 1n })).rejects.toThrow(/wallet client with an account/);
  });
});

describe('Transfer events', () => {
  const TRANSFER = erc20Abi.find((i) => i.type === 'event' && i.name === 'Transfer')!;
  const log = (from: Address, to: Address, value: bigint, block: bigint) => ({
    address: SBC.address,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }),
    data: word(value),
    blockNumber: numberToHex(block),
    transactionHash: numberToHex(block, { size: 32 }),
    transactionIndex: '0x0',
    blockHash: numberToHex(block, { size: 32 }),
    logIndex: '0x2',
    removed: false,
  });

  it('getTransfers decodes logs and forwards the filter', async () => {
    let filter: Record<string, unknown> = {};
    const node = fakeNode({ chainId: radiusTestnet.chainId, onLogs: (f) => { filter = f; return [log(OWNER.address, OTHER, 1_000n, 5n)]; } });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    const transfers = await getTransfers(client, { to: OTHER, fromBlock: 1n, toBlock: 10n });
    expect(transfers).toEqual([{ token: SBC.address, from: OWNER.address, to: OTHER, amount: 1_000n, transactionHash: numberToHex(5n, { size: 32 }), blockNumber: 5n, logIndex: 2 }]);
    expect((filter.address as string).toLowerCase()).toBe(SBC.address.toLowerCase());
    expect(filter.fromBlock).toBe('0x1');
    expect(filter.toBlock).toBe('0xa');
    const topics = filter.topics as (Hex | null)[];
    expect(topics[0]).toBe(encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer' })[0]);
    expect(topics[1]).toBeNull();
    expect((topics[2] as string).toLowerCase()).toBe(`0x${'0'.repeat(24)}${OTHER.slice(2)}`.toLowerCase());
  });

  it('watchTransfers polls and delivers decoded transfers until unwatched', async () => {
    let pending: unknown[] = [];
    const node = fakeNode({ chainId: radiusTestnet.chainId, advanceBlocks: true, onLogs: () => { const out = pending; pending = []; return out; } });
    const client = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport, pollingInterval: 5 });
    const seen: unknown[] = [];
    const unwatch = watchTransfers(client, { from: OWNER.address, onTransfer: (t) => seen.push(t), pollingInterval: 5 });
    pending = [log(OWNER.address, OTHER, 9n, 7n)];
    await new Promise((r) => setTimeout(r, 60));
    unwatch();
    expect(seen).toEqual([expect.objectContaining({ from: OWNER.address, to: OTHER, amount: 9n, blockNumber: 7n })]);
    const filterCalls = node.calls.filter((c) => c.method === 'eth_getLogs' || c.method === 'eth_newFilter');
    expect(filterCalls.length).toBeGreaterThan(0);
  });
});

describe('erc20Actions', () => {
  it('extends a wallet client, with a configurable default token', async () => {
    const { client, node } = walletClient();
    const w = client.extend(erc20Actions());
    expect(await w.getAllowance({ owner: OWNER.address, spender: SPENDER })).toBe(42n);
    await w.transfer({ to: OTHER, amount: '0.25' });
    expect(decodeSent(node)).toEqual({ to: SBC.address.toLowerCase(), functionName: 'transfer', args: [OTHER, 250_000n] });

    const u = client.extend(erc20Actions({ token: USDX }));
    expect((await u.getTokenMetadata()).symbol).toBe('USDX');
    expect((await u.getTokenMetadata({ token: SBC })).symbol).toBe('SBC');
  });
  it('defaults to the payment asset of a preset chain', async () => {
    const node = erc20Node();
    const mainnet = createPublicClient({ chain: radiusMainnet.chain, transport: node.transport }).extend(erc20Actions());
    expect((await mainnet.getTokenMetadata()).address).toBe(radiusMainnet.asset.address);
  });
  it('has no default token on a custom chain: token or network must be given', async () => {
    const node = erc20Node();
    const custom = defineRadiusNetwork({ chainId: 4242, rpcUrl: 'http://rpc', facilitatorUrl: 'http://f', asset: { address: USDX, decimals: 18, symbol: 'USDX' } });
    const bare = createPublicClient({ chain: custom.chain, transport: node.transport });
    await expect(getTokenMetadata(bare)).rejects.toMatchObject({ code: 'config' });
    await expect(getTokenMetadata(bare)).rejects.toThrow(/getTokenMetadata: no token given and chain 4242 is not a Radius preset/);
    await expect(getAllowance(bare, { owner: OWNER.address, spender: SPENDER })).rejects.toThrow(/getAllowance:/);
    await expect(transfer(createWalletClient({ account: OWNER, chain: custom.chain, transport: node.transport }), { to: OTHER, amount: 1n })).rejects.toThrow(/transfer:/);
    expect(node.sent).toHaveLength(0);
    // Explicit token, or the network's asset through the extension, or a bare token: all fine.
    expect((await getTokenMetadata(bare, { token: USDX })).symbol).toBe('USDX');
    expect((await bare.extend(erc20Actions({ network: custom })).getTokenMetadata()).symbol).toBe('USDX');
    expect((await bare.extend(erc20Actions({ token: custom.asset })).getTokenMetadata()).symbol).toBe('USDX');
  });
  it('rejects a network that is not the chain the client is on, and a client with no chain', async () => {
    const node = erc20Node();
    const testnet = createPublicClient({ chain: radiusTestnet.chain, transport: node.transport });
    expect(() => testnet.extend(erc20Actions({ network: 'mainnet' }))).toThrow(/network mainnet is chain 723487 but the client is on chain 72344/);
    const chainless = createPublicClient({ transport: node.transport });
    await expect(getTokenMetadata(chainless)).rejects.toThrow(/a client with no chain/);
    expect((await getTokenMetadata(chainless, { token: SBC })).symbol).toBe('SBC');
  });
});

describe('createRadiusFetch helpers', () => {
  it('allowance() and approve() act on the payment asset for the signer, through onApprovalRequired', async () => {
    const node = erc20Node();
    const network = defineRadiusNetwork({ chain: radiusTestnet.chain, facilitatorUrl: 'http://127.0.0.1:1' });
    const requests: ApprovalRequest[] = [];
    let allow = true;
    const payFetch = createRadiusFetch({ network, signer: PK, maxPerRequest: '$0.01', onApprovalRequired: (r) => { requests.push(r); return allow; } });
    // Route the SDK's own http() transport to the fake node.
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(await new Request(input, init).text()) as { id: number; method: string; params?: unknown[] };
      try {
        const result = await (node.transport({}) as unknown as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }).request(body);
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
      } catch (e) {
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: (e as Error).message } });
      }
    }) as typeof fetch;
    try {
      expect(await payFetch.allowance(SPENDER)).toBe(42n);
      const r = await payFetch.approve(SPENDER, '1');
      expect(r.status).toBe('success');
      expect(decodeSent(node)).toEqual({ to: SBC.address.toLowerCase(), functionName: 'approve', args: [SPENDER, 1_000_000n] });
      expect((await payFetch.approve(OTHER, maxUint256)).status).toBe('success');
      expect(decodeSent(node, 1).args).toEqual([OTHER, maxUint256]);
      expect(requests).toEqual([
        { reason: 'approve', asset: SBC.address, spender: SPENDER, amount: 1_000_000n, currentAllowance: 42n },
        { reason: 'approve', asset: SBC.address, spender: OTHER, amount: maxUint256, currentAllowance: 0n },
      ]);
      // approvePermit2() is gated the same way, and a veto sends nothing.
      await payFetch.approvePermit2();
      expect(requests[2]).toEqual({ reason: 'approvePermit2', asset: SBC.address, spender: PERMIT2_ADDRESS, amount: maxUint256, currentAllowance: 0n });
      expect(decodeSent(node, 2).args).toEqual([PERMIT2_ADDRESS, maxUint256]);
      allow = false;
      await expect(payFetch.approve(SPENDER, '2')).rejects.toMatchObject({ code: 'declined', details: { reason: 'approve', spender: SPENDER, amount: 2_000_000n } });
      await expect(payFetch.approvePermit2()).rejects.toMatchObject({ code: 'declined', details: { reason: 'approvePermit2' } });
      expect(node.sent).toHaveLength(3);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
