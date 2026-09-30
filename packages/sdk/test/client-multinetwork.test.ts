/** Real x402 payloads and recoverable signatures; RPC is local and no funds leave the process. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, createWalletClient, encodeDeployData, http, maxUint256, recoverTypedDataAddress, toHex, type Abi, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arcTestnet, base, monad, polygon } from 'viem/chains';
import { createEvmFetch, type EvmNetworkConfig, type PaymentReceipt } from '../src/client/index.js';
import { PERMIT2_ADDRESS, radiusMainnet, SBC, type RadiusAsset } from '../src/networks.js';
import { evmNode } from './evmNode.js';
import artifact from './fixtures/TestToken.json' with { type: 'json' };

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const recipient = '0x1111111111111111111111111111111111111111' as Address;
const facilitator = '0x2222222222222222222222222222222222222222' as Address;
const url = 'https://data.example/lookup';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (request: Request) => JSON.parse(Buffer.from(request.headers.get('payment-signature') ?? request.headers.get('x-payment')!, 'base64').toString());
const usdc = (address: Address, name = 'USD Coin'): RadiusAsset => ({ address, name, version: '2', symbol: 'USDC', decimals: 6 });
// Circle-issued ERC-20 addresses, not the chain's native balance representation.
const baseUsdc = usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const chainAssets: [Chain, RadiusAsset][] = [
  [radiusMainnet.chain, SBC],
  [base, baseUsdc],
  [arbitrum, usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')],
  [polygon, usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')],
  [monad, usdc('0x754704Bc059F8C67012fEd69BC8A327a5aafb603', 'USDC')],
  [arcTestnet, usdc('0x3600000000000000000000000000000000000000', 'USDC')],
];
const config = (chain: Chain, asset: RadiusAsset, maxPerRequest = '0.05'): EvmNetworkConfig => ({ chain, assets: [{ asset, maxPerRequest }], rpcUrl: `https://rpc-${chain.id}.example` });
const configs = chainAssets.map(([chain, asset]) => config(chain, asset));
const offer = (chain = base, asset = baseUsdc, amount = '13000') => ({
  scheme: 'exact', network: `eip155:${chain.id}`, asset: asset.address, payTo: recipient, amount, maxTimeoutSeconds: 120,
  extra: { assetTransferMethod: 'eip3009' }, // configured token domain fills in the signing copy
});
const challenge = (accepts: unknown[], extra = {}) => ({ x402Version: 2, resource: { url }, accepts, ...extra });
function seller(required: unknown, paid: (req: Request) => Response | Promise<Response> = () => Response.json({ data: 'enrichment' })) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return request.headers.has('payment-signature') || request.headers.has('x-payment') ? paid(request)
      : new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encode(required) } });
  };
  return { fetch, requests };
}
const types = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;
async function recover(payload: any, chain: Chain, asset: RadiusAsset) {
  const a = payload.payload.authorization;
  return recoverTypedDataAddress({ domain: { name: asset.name, version: asset.version, chainId: chain.id, verifyingContract: asset.address }, types, primaryType: 'TransferWithAuthorization',
    message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: payload.payload.signature });
}
function rpcAllowance(value = maxUint256) {
  const calls: { url: string; method: string; params: any[] }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text());
    const respond = (call: any) => {
      calls.push({ url: request.url, ...call });
      if (call.method !== 'eth_call') throw new Error(`Unexpected RPC ${call.method}`);
      return { jsonrpc: '2.0', id: call.id, result: toHex(call.params[0].data.startsWith('0xdd62ed3e') ? value : 0n, { size: 32 }) };
    };
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  });
  return calls;
}
afterEach(() => vi.restoreAllMocks());

describe('EVM network routing', () => {
  it.each(chainAssets)('signs exact on $0.name with its own token domain and chain id', async (chain, asset) => {
    const requirement = offer(chain, asset);
    const server = seller(challenge([requirement]));
    const rpc = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('EIP-3009 should not need RPC'));
    const pay = createEvmFetch({ signer: account, networks: configs, fetch: server.fetch });
    expect(await (await pay(url)).json()).toEqual({ data: 'enrichment' });
    expect(server.requests).toHaveLength(2);
    const payload = decode(server.requests[1]);
    expect(payload.accepted).toEqual(requirement);
    expect(await recover(payload, chain, asset)).toBe(account.address);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('skips SVM, unconfigured assets, unsupported schemes, and above-cap offers in server order', async () => {
    const wanted = offer(arbitrum, chainAssets[2][1], '40000');
    const server = seller(challenge([
      { ...offer(), network: 'solana:mainnet' },
      offer(base, SBC),
      { ...offer(), scheme: 'subscription' },
      offer(base, baseUsdc, '50001'),
      wanted,
      offer(radiusMainnet.chain, SBC, '1000'),
    ]));
    await createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url);
    expect(decode(server.requests[1]).accepted).toEqual(wanted);
  });

  it('uses independent token-unit caps for multiple assets on one chain', async () => {
    const token18 = { ...baseUsdc, address: recipient, symbol: 'CREDITS', decimals: 18, name: 'Credits', version: '1' };
    const server = seller(challenge([offer(base, token18, '50000000000000001'), offer()]));
    const pay = createEvmFetch({ signer: account, networks: [{ chain: base, assets: [{ asset: token18, maxPerRequest: '0.05' }, { asset: baseUsdc, maxPerRequest: '0.02' }] }], fetch: server.fetch });
    await pay(url);
    expect(pay.routes.map(r => r.maxPerRequest)).toEqual([50000000000000000n, 20000n]);
    expect(decode(server.requests[1]).accepted.asset).toBe(baseUsdc.address);
  });

  it.each([
    [challenge([{ ...offer(), network: 'solana:mainnet' }]), 'network_mismatch'],
    [challenge([offer(base, SBC)]), 'asset_mismatch'],
    [challenge([offer(base, baseUsdc, '50001')]), 'price_above_limit'],
    [challenge([{ ...offer(), extra: { assetTransferMethod: 'erc7710' } }]), 'unsupported_transfer_method'],
  ])('refuses incompatible challenges before signing or retrying (%s)', async (required, code) => {
    const signTypedData = vi.fn(account.signTypedData);
    const server = seller(required);
    await expect(createEvmFetch({ signer: { address: account.address, signTypedData }, networks: configs, fetch: server.fetch })(url)).rejects.toMatchObject({ code });
    expect(signTypedData).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
  });

  it('makes a policy decline terminal, even when another chain is affordable', async () => {
    const server = seller(challenge([offer(), offer(radiusMainnet.chain, SBC)]));
    const onPaymentRequired = vi.fn(() => false);
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch, onPaymentRequired })(url)).rejects.toMatchObject({ code: 'declined' });
    expect(onPaymentRequired).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
  });

  it('pays a legacy v1 CAIP-2 challenge with the selected chain and X-PAYMENT', async () => {
    const requests: Request[] = [];
    const { amount, ...req } = offer();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      return request.headers.has('x-payment') ? new Response('legacy data')
        : Response.json({ x402Version: 1, accepts: [{ ...req, maxAmountRequired: amount, resource: url }] }, { status: 402 });
    };
    await createEvmFetch({ signer: account, networks: configs, fetch })(url);
    const payload = decode(requests[1]);
    expect(requests[1].headers.has('payment-signature')).toBe(false);
    expect(payload).toMatchObject({ x402Version: 1, network: 'eip155:8453', scheme: 'exact' });
    expect(await recover(payload, base, baseUsdc)).toBe(account.address);
  });

  it('keeps concurrent requests, POST bodies and chain-specific signers separate', async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const req = new Request(input, init); requests.push(req);
      const index = req.url.endsWith('/base') ? 1 : 2;
      const [chain, asset] = chainAssets[index];
      if (!req.headers.has('payment-signature')) return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encode(challenge([offer(chain, asset)])) } });
      await Promise.resolve();
      expect(await recover(decode(req), chain, asset)).toBe(index === 1 ? account.address : otherAccount.address);
      expect(req.method).toBe('POST');
      expect(req.headers.get('authorization')).toBe('Bearer test-fixture');
      expect(req.redirect).toBe('manual');
      return Response.json({ body: await req.text() });
    };
    const pay = createEvmFetch({ signer: account, networks: [configs[1], { ...configs[2], signer: otherAccount }], fetch });
    const result = await Promise.all(['base', 'arbitrum'].map(async name => (await pay(`${url}/${name}`, { method: 'POST', body: name, headers: { authorization: 'Bearer test-fixture' } })).json()));
    expect(result).toEqual([{ body: 'base' }, { body: 'arbitrum' }]);
    expect(requests).toHaveLength(4);
  });

  it('rejects a WalletClient bound to the wrong chain during configuration', () => {
    const wallet = createWalletClient({ account, chain: base, transport: http() });
    expect(() => createEvmFetch({ signer: wallet, networks: [configs[2]] })).toThrow(/WalletClient chain 8453 does not match payment chain 42161/);
  });

  it('requires complete token metadata, unique routes, and a cap for the configured asset', () => {
    expect(() => createEvmFetch({ signer: account, networks: [{ chain: base, assets: [{ asset: { address: baseUsdc.address } as RadiusAsset, maxPerRequest: '1' }] }] })).toThrow(/Incomplete ERC-20/);
    expect(() => createEvmFetch({ signer: account, networks: [configs[1], configs[1]] })).toThrow(/Duplicate network/);
    expect(() => createEvmFetch({ signer: account, networks: [{ chain: base, assets: [{ asset: baseUsdc, maxPerRequest: { amount: '5', asset: SBC.address } }] }] })).toThrow(/asset must match/);
  });
});

describe('Permit2 and receipts across networks', () => {
  it.each(['exact', 'upto'])('signs %s Permit2 on Arbitrum with that chain allowance and witness', async scheme => {
    const calls = rpcAllowance();
    const [chain, asset] = chainAssets[2];
    const required = { ...offer(chain, asset, '50000'), scheme, extra: { assetTransferMethod: 'permit2', ...(scheme === 'upto' ? { facilitatorAddress: facilitator } : {}) } };
    const receipts: PaymentReceipt[] = [];
    const server = seller(challenge([required]), () => new Response('data', { headers: { 'PAYMENT-RESPONSE': encode({ success: true, network: required.network, transaction: `0x${'ab'.repeat(32)}`, ...(scheme === 'upto' ? { amount: '12000' } : {}) }) } }));
    await createEvmFetch({ signer: account, networks: configs, fetch: server.fetch, onPaid: r => { receipts.push(r); } })(url);
    const payload = decode(server.requests[1]);
    const a = payload.payload.permit2Authorization;
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: chain.id, verifyingContract: PERMIT2_ADDRESS },
      primaryType: 'PermitWitnessTransferFrom',
      types: {
        PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        Witness: [{ name: 'to', type: 'address' }, ...(scheme === 'upto' ? [{ name: 'facilitator', type: 'address' }] : []), { name: 'validAfter', type: 'uint256' }],
      },
      message: { ...a, permitted: { ...a.permitted, amount: BigInt(a.permitted.amount) }, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { ...a.witness, validAfter: BigInt(a.witness.validAfter) } },
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(account.address);
    expect(calls.every(c => c.url === configs[2].rpcUrl + '/')).toBe(true);
    expect(calls[0].params[0].to.toLowerCase()).toBe(asset.address.toLowerCase());
    expect(receipts[0]).toMatchObject({ amount: scheme === 'upto' ? '12000' : '50000', network: required.network, explorerUrl: `${chain.blockExplorers!.default.url}/tx/0x${'ab'.repeat(32)}` });
  });

  it('does not send an approval by default when allowance is missing', async () => {
    const calls = rpcAllowance(0n);
    const server = seller(challenge([{ ...offer(), extra: { assetTransferMethod: 'permit2' } }]));
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url)).rejects.toMatchObject({ code: 'approval_required', details: { reason: 'payment', offer: { network: 'eip155:8453' } } });
    expect(calls.map(c => c.method)).toEqual(['eth_call']);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects an upto maximum above the cap before allowance reads', async () => {
    const rpc = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No RPC expected'));
    const server = seller(challenge([{ ...offer(base, baseUsdc, '50001'), scheme: 'upto', extra: { facilitatorAddress: facilitator } }]));
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url)).rejects.toMatchObject({ code: 'price_above_limit' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('supports sponsored Permit2 without making an approval transaction', async () => {
    const calls = rpcAllowance(0n);
    const server = seller(challenge([{ ...offer(), extra: { assetTransferMethod: 'permit2' } }], { extensions: { eip2612GasSponsoring: { version: '1' } } }));
    await createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url);
    expect(decode(server.requests[1]).extensions.eip2612GasSponsoring.info).toMatchObject({ asset: baseUsdc.address, spender: PERMIT2_ADDRESS, amount: '13000' });
    expect(calls.every(c => c.method === 'eth_call' && c.url === configs[1].rpcUrl + '/')).toBe(true);
  });

  it('lets approval policy veto an explicitly enabled auto approval', async () => {
    const calls = rpcAllowance(0n);
    const server = seller(challenge([{ ...offer(), extra: { assetTransferMethod: 'permit2' } }]));
    const onApprovalRequired = vi.fn(() => false);
    await expect(createEvmFetch({ signer: account, networks: [{ ...configs[1], permit2Approval: 'auto' }], fetch: server.fetch, onApprovalRequired })(url)).rejects.toMatchObject({ code: 'declined' });
    expect(onApprovalRequired).toHaveBeenCalledOnce();
    expect(calls.map(c => c.method)).toEqual(['eth_call']);
    expect(server.requests).toHaveLength(1);
  });

  it('refuses a receipt from a different chain instead of attaching the selected explorer', async () => {
    const server = seller(challenge([offer()]), () => new Response('data', { headers: { 'PAYMENT-RESPONSE': encode({ success: true, network: 'eip155:42161', transaction: `0x${'ab'.repeat(32)}` }) } }));
    const onPaid = vi.fn();
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch, onPaid })(url)).rejects.toMatchObject({ code: 'invalid_receipt' });
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin paid redirect without forwarding its signature', async () => {
    const server = seller(challenge([offer()]), () => new Response(null, { status: 307, headers: { location: 'https://other.example/lookup' } }));
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url)).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].redirect).toBe('manual');
  });

  it('does not synthesize a receipt for HTTP success without settlement evidence', async () => {
    const server = seller(challenge([offer()]));
    const onPaid = vi.fn();
    await createEvmFetch({ signer: account, networks: configs, fetch: server.fetch, onPaid })(url);
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('surfaces a paid rejection without retrying on another network', async () => {
    const server = seller(challenge([offer(), offer(radiusMainnet.chain, SBC)]), () => new Response('rejected', { status: 402 }));
    await expect(createEvmFetch({ signer: account, networks: configs, fetch: server.fetch })(url)).rejects.toMatchObject({ code: 'payment_rejected' });
    expect(server.requests).toHaveLength(2);
  });

  it('executes explicitly allowed approval on the selected EVM and reconciles a real token transfer', async () => {
    const node = await evmNode({ chainId: base.id, accounts: [account.address], blockNumber: 100n });
    const tokenAddress = await node.deploy(encodeDeployData({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, args: [6, 1000000n] }), account.address);
    const token = { address: tokenAddress, decimals: 6, symbol: 'TST', name: 'Test Token', version: '1' };
    const transport = node.transport({ chain: base });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://rpc-8453.example/');
      const body = JSON.parse(await request.text());
      const respond = async (call: any) => ({ jsonrpc: '2.0', id: call.id, result: await transport.request({ method: call.method, params: call.params }) });
      return Response.json(Array.isArray(body) ? await Promise.all(body.map(respond)) : await respond(body));
    });
    const server = seller(challenge([{ ...offer(base, token), extra: { assetTransferMethod: 'permit2' } }]));
    const onApprovalRequired = vi.fn(() => true);
    const pay = createEvmFetch({ signer: account, networks: [configs[0], { ...config(base, token), permit2Approval: 'auto' }], fetch: server.fetch, onApprovalRequired });
    await pay(url);
    expect(onApprovalRequired).toHaveBeenCalledOnce();
    expect(onApprovalRequired.mock.calls[0][0]).toMatchObject({ reason: 'payment', amount: maxUint256, offer: { network: 'eip155:8453' } });
    const pc = createPublicClient({ chain: base, transport: node.transport });
    expect(await pc.readContract({ address: tokenAddress, abi: artifact.abi, functionName: 'allowance', args: [account.address, PERMIT2_ADDRESS] })).toBe(maxUint256);
    await pay(url);
    expect(node.sent).toHaveLength(1); // second purchase reuses the real allowance
    const wallet = createWalletClient({ account, chain: base, transport: node.transport });
    const hash = await wallet.writeContract({ address: tokenAddress, abi: artifact.abi, functionName: 'transfer', args: [recipient, 13000n] });
    const settled = await pay.routes[1].getSettlement(hash);
    expect(settled?.status).toBe('success');
    expect(settled?.paid(recipient)).toBe(13000n);
    expect(settled?.paidFormatted(recipient)).toBe('0.013 TST');
  });
});
