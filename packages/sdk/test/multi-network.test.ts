/**
 * Paying on several networks: Radius plus Base Sepolia. Nothing touches a chain: sellers are mock fetches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, RadiusPaymentError, type PaymentOffer, type RadiusFetchOptions } from '../src/client/index.js';
import { baseMainnet, baseSepolia, radiusTestnet, SBC, USDC_BASE_SEPOLIA } from '../src/networks.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SIGNER = privateKeyToAccount(PK);
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const URL_ = 'https://api.example.com/r';
const TX = `0x${'ab'.repeat(32)}`;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const radiusOffer = (amount = '1000') => ({
  scheme: 'exact',
  network: radiusTestnet.network,
  asset: SBC.address,
  payTo: PAY_TO,
  amount,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: SBC.name, version: SBC.version },
});
const baseOffer = (amount = '1000') => ({
  scheme: 'exact',
  network: baseSepolia.network,
  asset: USDC_BASE_SEPOLIA.address,
  payTo: PAY_TO,
  amount,
  maxTimeoutSeconds: 60,
  extra: { name: USDC_BASE_SEPOLIA.name, version: USDC_BASE_SEPOLIA.version },
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

function seller(challenge: { x402Version: number }, paid: () => Response = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.headers.has('payment-signature') || req.headers.has('x-payment')) return paid();
    if (challenge.x402Version === 2) return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(challenge) } });
    return Response.json(challenge, { status: 402 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const v2 = (...accepts: unknown[]) => ({ x402Version: 2, resource: { url: URL_ }, accepts });

async function pay(challenge: { x402Version: number }, options: Partial<RadiusFetchOptions>, paid?: () => Response) {
  const server = seller(challenge, paid);
  const offers: PaymentOffer[] = [];
  const res = await createRadiusFetch({
    networks: ['testnet', 'base-sepolia'],
    signer: PK,
    maxPerRequest: '$0.01',
    fetch: server.fetch,
    onPaymentRequired: (o) => {
      offers.push(o);
      return true;
    },
    ...options,
  })(URL_);
  const header = server.requests[1]?.headers.get('payment-signature') ?? server.requests[1]?.headers.get('x-payment');
  return { res, offer: offers[0], decoded: header ? fromB64(header) : undefined };
}

const rejects = (p: Promise<unknown>, code: string, message?: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof RadiusPaymentError && e.code === code && (!message || message.test(e.message)));

afterEach(() => vi.restoreAllMocks());

describe('createRadiusFetch on several networks', () => {
  it('pays a Base offer in USDC, signed for the Base Sepolia USDC domain', async () => {
    const { offer, decoded } = await pay(v2(baseOffer()), {});
    expect(offer.network).toBe(baseSepolia);
    expect(offer).toMatchObject({ amount: '1000', amountFormatted: '0.001 USDC', transferMethod: 'eip3009', asset: USDC_BASE_SEPOLIA.address });
    const { authorization, signature } = decoded.payload;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA.address },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(signer).toBe(SIGNER.address);
    expect(decoded.accepted).toEqual(baseOffer());
  });

  it("prefers the client's network order, whatever order the server lists them in", async () => {
    expect((await pay(v2(baseOffer(), radiusOffer()), {})).offer.network).toBe(radiusTestnet);
    expect((await pay(v2(radiusOffer(), baseOffer()), { networks: ['base-sepolia', 'testnet'] })).offer.network).toBe(baseSepolia);
  });

  it('falls through to the next network when the preferred one is over the cap', async () => {
    const { offer } = await pay(v2(radiusOffer('20000'), baseOffer('5000')), {});
    expect(offer).toMatchObject({ network: baseSepolia, amount: '5000' });
    await rejects(pay(v2(radiusOffer('20000'), baseOffer('20000')), {}), 'price_above_limit', /0\.02 SBC exceeds maxPerRequest 0\.01 SBC/);
  });

  it('converts a USD cap for each network and applies an atomic cap to each as-is', () => {
    const usd = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: '$0.05' });
    expect(usd.on('base-sepolia').maxPerRequest).toBe(50_000n);
    expect(usd.maxPerRequest).toBe(50_000n);
    const atomic = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: { amount: '7' } });
    expect(atomic.on(baseSepolia).maxPerRequest).toBe(7n);
  });

  it('pays an x402 v1 challenge that names Base by its v1 network name', async () => {
    const v1 = {
      x402Version: 1,
      accepts: [{ ...baseOffer(), network: 'base-sepolia', amount: undefined, maxAmountRequired: '1000', resource: URL_, description: 'd', mimeType: 'application/json' }],
    };
    const { offer, decoded } = await pay(v1, {});
    expect(offer.network).toBe(baseSepolia);
    expect(decoded).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'base-sepolia' });
    const { authorization, signature } = decoded.payload;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA.address },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(signer).toBe(SIGNER.address);
  });

  it('decodes the receipt against the network that was paid', async () => {
    const paid = () => Response.json({ ok: true }, { headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX, network: baseSepolia.network, payer: SIGNER.address }) } });
    let receipt: { explorerUrl?: string } | undefined;
    await pay(v2(baseOffer()), { onPaid: (r) => void (receipt = r) }, paid);
    expect(receipt?.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${TX}`);
  });

  it('names every enabled network when nothing matches', async () => {
    await rejects(pay(v2({ ...baseOffer(), network: 'eip155:1' }), {}), 'network_mismatch', /eip155:72344 \(radius-testnet\), eip155:84532 \(base-sepolia\)/);
    await rejects(pay(v2({ ...baseOffer(), asset: SBC.address }), {}), 'asset_mismatch', /USDC \(0x036C/);
  });

  it('only pays on networks it was given', async () => {
    await rejects(pay(v2(baseOffer()), { networks: undefined, network: 'testnet' }), 'network_mismatch');
  });

  it('exposes wallet helpers per network', () => {
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: '$0.01' });
    expect(payFetch.network).toBe(radiusTestnet);
    expect(payFetch.networks).toEqual([radiusTestnet, baseSepolia]);
    expect(payFetch.on('base-sepolia').network).toBe(baseSepolia);
    expect(payFetch.on('eip155:84532').network).toBe(baseSepolia);
    expect(payFetch.on(radiusTestnet).network).toBe(radiusTestnet);
    expect(() => payFetch.on('base')).toThrow(/base is not one of this client's networks/);
    expect(() => payFetch.on(baseMainnet)).toThrow(/not one of this client's networks/);
  });

  it('applies top-level overrides to the first network only', () => {
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], rpcUrl: 'https://rpc.example', signer: PK, maxPerRequest: '$0.01' });
    expect(payFetch.network.rpcUrl).toBe('https://rpc.example');
    expect(payFetch.on('base-sepolia').network.rpcUrl).toBe('https://sepolia.base.org');
  });

  it('rejects ambiguous or duplicate network configuration', () => {
    const base = { signer: PK, maxPerRequest: '$0.01' } as const;
    expect(() => createRadiusFetch({ ...base, network: 'testnet', networks: ['base'] })).toThrow(/network or networks, not both/);
    expect(() => createRadiusFetch({ ...base, networks: [] })).toThrow(/networks is empty/);
    expect(() => createRadiusFetch({ ...base, networks: ['testnet', 'radius-testnet'] })).toThrow(/listed twice/);
  });

  it('sends transactions on a WalletClient signer only on the chain it is connected to', async () => {
    const { createWalletClient, http } = await import('viem');
    const wc = createWalletClient({ account: SIGNER, chain: radiusTestnet.chain, transport: http('http://127.0.0.1:1') });
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: wc, maxPerRequest: '$0.01' });
    await expect(payFetch.on('base-sepolia').send(PAY_TO, '0.01')).rejects.toThrow(/connected to chain 72344, not base-sepolia/);
  });
});
