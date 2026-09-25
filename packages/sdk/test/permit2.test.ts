import { createPublicClient, createWalletClient, decodeFunctionData, encodeAbiParameters, erc20Abi, hashStruct, hashTypedData, keccak256, maxUint160, maxUint256, numberToHex, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  approvePermit2,
  encodeTypedDataType,
  getPermit2Allowance,
  getPermit2Approval,
  isPermit2NonceUsed,
  PERMIT2_ABI,
  PERMIT_SINGLE_TYPES,
  PERMIT_TRANSFER_FROM_TYPES,
  permit2Actions,
  permit2AllowanceTransferFrom,
  permit2Domain,
  permit2Permit,
  permit2TransferFrom,
  permit2WitnessHash,
  permit2WitnessTypeString,
  permitWitnessTransferFromTypes,
  randomPermit2Nonce,
  signPermit2Allowance,
  signPermit2Transfer,
  type Permit2Witness,
} from '../src/permit2.js';
import { defineRadiusNetwork, PERMIT2_ADDRESS, radiusTestnet, SBC, X402_EXACT_PERMIT2_PROXY } from '../src/networks.js';
import { fakeNode } from './fakeNode.js';

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SPENDER_PK = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as Hex;
const OWNER = privateKeyToAccount(OWNER_PK);
const SPENDER = privateKeyToAccount(SPENDER_PK);
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const FACILITATOR = '0x00000000000000000000000000000000fac11107' as Address;
const CHAIN_ID = radiusTestnet.chainId;
const NOW = Math.floor(Date.now() / 1000);

const word = (v: bigint | number) => numberToHex(BigInt(v), { size: 32 });

/** Permit2 + SBC view answers. */
function node(state: { erc20Allowance?: bigint; allowance?: [bigint, number, number]; bitmap?: bigint } = {}) {
  return fakeNode({
    chainId: CHAIN_ID,
    onCall: ({ to, data }) => {
      if (to!.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
        const { functionName, args } = decodeFunctionData({ abi: PERMIT2_ABI, data: data! });
        if (functionName === 'allowance') {
          const [amount, expiration, nonce] = state.allowance ?? [0n, 0, 0];
          expect((args as Address[])[1].toLowerCase()).toBe(SBC.address.toLowerCase());
          return encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [amount, expiration, nonce]);
        }
        if (functionName === 'nonceBitmap') return word(state.bitmap ?? 0n);
        throw new Error(`unexpected Permit2 view ${functionName}`);
      }
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: data! });
      if (functionName === 'allowance') {
        expect((args as Address[])[1].toLowerCase()).toBe(PERMIT2_ADDRESS.toLowerCase());
        return word(state.erc20Allowance ?? 0n);
      }
      if (functionName === 'decimals') return word(6);
      throw new Error(`unexpected ERC-20 view ${functionName}`);
    },
  });
}

const ownerClient = (n = node()) => ({ n, client: createWalletClient({ account: OWNER, chain: radiusTestnet.chain, transport: n.transport }) });
const spenderClient = (n = node()) => ({ n, client: createWalletClient({ account: SPENDER, chain: radiusTestnet.chain, transport: n.transport }) });

const X402_WITNESS: Permit2Witness = {
  typeName: 'Witness',
  types: { Witness: [{ name: 'to', type: 'address' }, { name: 'facilitator', type: 'address' }, { name: 'validAfter', type: 'uint256' }] },
  value: { to: PAY_TO, facilitator: FACILITATOR, validAfter: 0n },
};

describe('type encoding', () => {
  it('encodeTypedDataType lists the primary type then referenced structs alphabetically', () => {
    expect(encodeTypedDataType('PermitTransferFrom', PERMIT_TRANSFER_FROM_TYPES)).toBe(
      'PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)',
    );
    expect(encodeTypedDataType('PermitSingle', PERMIT_SINGLE_TYPES)).toBe(
      'PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)',
    );
  });

  it('permit2WitnessTypeString matches the x402 / Permit2 WITNESS_TYPE_STRING layout', () => {
    // As radius-cli's upto scheme signs it and the deployed x402UptoPermit2Proxy verifies it.
    expect(permit2WitnessTypeString(X402_WITNESS)).toBe('Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)');
    // A witness struct that sorts before TokenPermissions moves ahead of it.
    const order: Permit2Witness = { typeName: 'Order', types: { Order: [{ name: 'id', type: 'bytes32' }] }, value: { id: '0x'.padEnd(66, '1') } };
    expect(permit2WitnessTypeString(order)).toBe('Order witness)Order(bytes32 id)TokenPermissions(address token,uint256 amount)');
    // Nested witness structs are included once, sorted.
    const nested: Permit2Witness = {
      typeName: 'Witness',
      types: { Witness: [{ name: 'order', type: 'Order' }, { name: 'items', type: 'Item[]' }], Order: [{ name: 'id', type: 'uint256' }], Item: [{ name: 'sku', type: 'string' }] },
      value: {},
    };
    expect(permit2WitnessTypeString(nested)).toBe('Witness witness)Item(string sku)Order(uint256 id)TokenPermissions(address token,uint256 amount)Witness(Order order,Item[] items)');
  });

  it('agrees with viem on the type hash, so the on-chain string verifies the signed digest', () => {
    const types = permitWitnessTransferFromTypes(X402_WITNESS);
    const stub = 'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';
    const typeHash = keccak256(toHex(stub + permit2WitnessTypeString(X402_WITNESS)));
    // hashStruct(PermitWitnessTransferFrom) == keccak(typeHash ‖ encodeData); recompute with viem's own primitives.
    const data = { permitted: { token: SBC.address, amount: 1n }, spender: SPENDER.address, nonce: 7n, deadline: 9n, witness: X402_WITNESS.value };
    const viemHash = hashStruct({ primaryType: 'PermitWitnessTransferFrom', types, data } as never);
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
        [typeHash, hashStruct({ primaryType: 'TokenPermissions', types, data: data.permitted } as never), SPENDER.address, 7n, 9n, permit2WitnessHash(X402_WITNESS)],
      ),
    );
    expect(viemHash).toBe(manual);
  });

  it('permit2Domain and randomPermit2Nonce', () => {
    expect(permit2Domain(CHAIN_ID)).toEqual({ name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS });
    const a = randomPermit2Nonce();
    const b = randomPermit2Nonce();
    expect(a).not.toBe(b);
    expect(a).toBeLessThanOrEqual(maxUint256);
  });
});

describe('reads', () => {
  it('getPermit2Approval reads the ERC-20 allowance granted to Permit2', async () => {
    const { client } = ownerClient(node({ erc20Allowance: 5n }));
    expect(await getPermit2Approval(client, { owner: OWNER.address })).toBe(5n);
  });
  it('getPermit2Allowance decodes (amount, expiration, nonce)', async () => {
    const { client } = ownerClient(node({ allowance: [123n, NOW + 60, 3] }));
    expect(await getPermit2Allowance(client, { owner: OWNER.address, spender: SPENDER.address })).toEqual({ amount: 123n, expiration: NOW + 60, nonce: 3 });
  });
  it('isPermit2NonceUsed reads the right word and bit of the bitmap', async () => {
    const nonce = (5n << 8n) | 130n; // word 5, bit 130
    const n = node({ bitmap: 1n << 130n });
    const { client } = ownerClient(n);
    expect(await isPermit2NonceUsed(client, { owner: OWNER.address, nonce })).toBe(true);
    expect(await isPermit2NonceUsed(client, { owner: OWNER.address, nonce: nonce + 1n })).toBe(false);
    const call = n.calls.find((c) => c.method === 'eth_call')!.params[0] as { data: Hex };
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: call.data })).toEqual({ functionName: 'nonceBitmap', args: [OWNER.address, 5n] });
  });
});

describe('owner side', () => {
  it('approvePermit2 approves Permit2 for the token, unlimited by default', async () => {
    const { client, n } = ownerClient();
    const r = await approvePermit2(client);
    expect(r.status).toBe('success');
    expect(n.sent[0].to).toBe(SBC.address.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: n.sent[0].data! })).toEqual({ functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] });
    await approvePermit2(client, { amount: '1.5' });
    expect(decodeFunctionData({ abi: erc20Abi, data: n.sent[1].data! }).args).toEqual([PERMIT2_ADDRESS, 1_500_000n]);
  });

  it('signPermit2Transfer signs a PermitTransferFrom that recovers to the owner', async () => {
    const { client, n } = ownerClient();
    const signed = await signPermit2Transfer(client, { amount: '0.01', spender: SPENDER.address, nonce: 42n, deadline: NOW + 300 });
    expect(signed).toMatchObject({ permit: { permitted: { token: SBC.address, amount: 10_000n }, nonce: 42n, deadline: BigInt(NOW + 300) }, spender: SPENDER.address, owner: OWNER.address, chainId: CHAIN_ID });
    expect(signed.witness).toBeUndefined();
    expect(n.methods()).not.toContain('eth_sendRawTransaction');
    const recovered = await recoverTypedDataAddress({
      domain: permit2Domain(CHAIN_ID),
      types: PERMIT_TRANSFER_FROM_TYPES,
      primaryType: 'PermitTransferFrom',
      message: { permitted: signed.permit.permitted, spender: signed.spender, nonce: signed.permit.nonce, deadline: signed.permit.deadline },
      signature: signed.signature,
    });
    expect(recovered).toBe(OWNER.address);
  });

  it('signPermit2Transfer with a witness produces the x402-shaped digest', async () => {
    const { client } = ownerClient();
    const signed = await signPermit2Transfer(client, { amount: 13_000n, spender: X402_EXACT_PERMIT2_PROXY, nonce: 1n, deadline: NOW + 120, witness: X402_WITNESS });
    expect(signed.witness).toBe(X402_WITNESS);
    const digest = hashTypedData({
      domain: permit2Domain(CHAIN_ID),
      types: permitWitnessTransferFromTypes(X402_WITNESS),
      primaryType: 'PermitWitnessTransferFrom',
      message: { permitted: signed.permit.permitted, spender: X402_EXACT_PERMIT2_PROXY, nonce: 1n, deadline: BigInt(NOW + 120), witness: X402_WITNESS.value },
    } as never);
    expect(
      await recoverTypedDataAddress({
        domain: permit2Domain(CHAIN_ID),
        types: permitWitnessTransferFromTypes(X402_WITNESS),
        primaryType: 'PermitWitnessTransferFrom',
        message: { permitted: signed.permit.permitted, spender: X402_EXACT_PERMIT2_PROXY, nonce: 1n, deadline: BigInt(NOW + 120), witness: X402_WITNESS.value },
        signature: signed.signature,
      } as never),
    ).toBe(OWNER.address);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('defaults the nonce to a random value and the deadline to ~10 minutes; rejects past deadlines', async () => {
    const { client } = ownerClient();
    const a = await signPermit2Transfer(client, { amount: 1n, spender: SPENDER.address });
    const b = await signPermit2Transfer(client, { amount: 1n, spender: SPENDER.address });
    expect(a.permit.nonce).not.toBe(b.permit.nonce);
    expect(Number(a.permit.deadline) - NOW).toBeGreaterThanOrEqual(598);
    expect(Number(a.permit.deadline) - NOW).toBeLessThanOrEqual(602);
    await expect(signPermit2Transfer(client, { amount: 1n, spender: SPENDER.address, deadline: NOW - 1 })).rejects.toThrow(/in the past/);
  });

  it('signPermit2Allowance reads the nonce from Permit2 and signs a PermitSingle', async () => {
    const { client } = ownerClient(node({ allowance: [0n, 0, 4] }));
    const signed = await signPermit2Allowance(client, { amount: '2', spender: SPENDER.address, expiration: NOW + 3600, sigDeadline: NOW + 60 });
    expect(signed.permitSingle).toEqual({ details: { token: SBC.address, amount: 2_000_000n, expiration: NOW + 3600, nonce: 4 }, spender: SPENDER.address, sigDeadline: BigInt(NOW + 60) });
    expect(
      await recoverTypedDataAddress({ domain: permit2Domain(CHAIN_ID), types: PERMIT_SINGLE_TYPES, primaryType: 'PermitSingle', message: signed.permitSingle, signature: signed.signature }),
    ).toBe(OWNER.address);
    await expect(signPermit2Allowance(client, { amount: maxUint160 + 1n, spender: SPENDER.address, expiration: NOW + 1 })).rejects.toThrow(/uint160/);
    await expect(signPermit2Allowance(client, { amount: 1n, spender: SPENDER.address, expiration: 1.5 })).rejects.toThrow(/uint48/);
  });

  it('needs an account', async () => {
    const pub = createPublicClient({ chain: radiusTestnet.chain, transport: node().transport });
    await expect(signPermit2Transfer(pub as never, { amount: 1n, spender: SPENDER.address })).rejects.toMatchObject({ code: 'config' });
  });
});

describe('spender side', () => {
  it('permit2TransferFrom submits permitTransferFrom with the signed permit', async () => {
    const signed = await signPermit2Transfer(ownerClient().client, { amount: 10_000n, spender: SPENDER.address, nonce: 9n, deadline: NOW + 100 });
    const { client, n } = spenderClient();
    const r = await permit2TransferFrom(client, { signed, to: PAY_TO, amount: 6_000n });
    expect(r.status).toBe('success');
    expect(n.sent[0].to).toBe(PERMIT2_ADDRESS.toLowerCase());
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: n.sent[0].data! })).toEqual({
      functionName: 'permitTransferFrom',
      args: [{ permitted: { token: SBC.address, amount: 10_000n }, nonce: 9n, deadline: BigInt(NOW + 100) }, { to: PAY_TO, requestedAmount: 6_000n }, OWNER.address, signed.signature],
    });
    // Default amount is the full permitted amount; more than permitted is refused before sending.
    await permit2TransferFrom(client, { signed, to: PAY_TO });
    expect((decodeFunctionData({ abi: PERMIT2_ABI, data: n.sent[1].data! }).args as [unknown, { requestedAmount: bigint }])[1].requestedAmount).toBe(10_000n);
    await expect(permit2TransferFrom(client, { signed, to: PAY_TO, amount: 10_001n })).rejects.toThrow(/exceeds the permitted/);
  });

  it('permit2TransferFrom with a witness submits permitWitnessTransferFrom with hash and type string', async () => {
    const signed = await signPermit2Transfer(ownerClient().client, { amount: 1n, spender: SPENDER.address, nonce: 2n, deadline: NOW + 100, witness: X402_WITNESS });
    const { client, n } = spenderClient();
    await permit2TransferFrom(client, { signed, to: PAY_TO });
    const decoded = decodeFunctionData({ abi: PERMIT2_ABI, data: n.sent[0].data! });
    expect(decoded.functionName).toBe('permitWitnessTransferFrom');
    const [, , owner, witness, typeString, signature] = decoded.args as [unknown, unknown, Address, Hex, string, Hex];
    expect(owner).toBe(OWNER.address);
    expect(witness).toBe(permit2WitnessHash(X402_WITNESS));
    expect(witness).toBe(hashStruct({ primaryType: 'Witness', types: X402_WITNESS.types, data: X402_WITNESS.value } as never));
    expect(typeString).toBe('Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)');
    expect(signature).toBe(signed.signature);
  });

  it('refuses to submit a permit signed for another spender', async () => {
    const signed = await signPermit2Transfer(ownerClient().client, { amount: 1n, spender: PAY_TO });
    await expect(permit2TransferFrom(spenderClient().client, { signed, to: PAY_TO })).rejects.toThrow(/must be sent by the permit's spender/);
  });

  it('permit2Permit and permit2AllowanceTransferFrom encode the AllowanceTransfer calls', async () => {
    const signed = await signPermit2Allowance(ownerClient(node({ allowance: [0n, 0, 0] })).client, { amount: 5_000_000n, spender: SPENDER.address, expiration: NOW + 3600, sigDeadline: NOW + 60 });
    const { client, n } = spenderClient();
    await permit2Permit(client, { signed });
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: n.sent[0].data! })).toEqual({ functionName: 'permit', args: [OWNER.address, signed.permitSingle, signed.signature] });
    await permit2AllowanceTransferFrom(client, { from: OWNER.address, to: PAY_TO, amount: '1.25' });
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: n.sent[1].data! })).toEqual({ functionName: 'transferFrom', args: [OWNER.address, PAY_TO, 1_250_000n, SBC.address] });
    expect(n.sent.every((t) => t.to === PERMIT2_ADDRESS.toLowerCase())).toBe(true);
  });
});

describe('default token', () => {
  it('has none on a custom chain until token or network is given', async () => {
    const n = node();
    const custom = defineRadiusNetwork({ chainId: 4242, rpcUrl: 'http://rpc', facilitatorUrl: 'http://f', asset: { address: '0x2222222222222222222222222222222222222222', decimals: 6, symbol: 'USDX' } });
    const client = createWalletClient({ account: OWNER, chain: custom.chain, transport: n.transport });
    await expect(getPermit2Approval(client, { owner: OWNER.address })).rejects.toMatchObject({ code: 'config' });
    await expect(approvePermit2(client)).rejects.toThrow(/approvePermit2: no token given and chain 4242 is not a Radius preset/);
    await expect(signPermit2Transfer(client, { spender: SPENDER.address, amount: 1n })).rejects.toThrow(/signPermit2Transfer:/);
    expect(n.sent).toHaveLength(0);
    expect(() => client.extend(permit2Actions({ network: 'testnet' }))).toThrow(/network testnet is chain 72344 but the client is on chain 4242/);
    // With the network (or an explicit token) the custom asset is used.
    const signed = await client.extend(permit2Actions({ network: custom })).signPermit2Transfer({ spender: SPENDER.address, amount: 1n, nonce: 1n, deadline: BigInt(NOW + 60) });
    expect(signed.permit.permitted.token).toBe(custom.asset.address);
  });
});

describe('permit2Actions', () => {
  it('extends wallet clients on both sides of a transfer', async () => {
    const shared = node({ erc20Allowance: maxUint256 });
    const owner = createWalletClient({ account: OWNER, chain: radiusTestnet.chain, transport: shared.transport }).extend(permit2Actions());
    const spender = createWalletClient({ account: SPENDER, chain: radiusTestnet.chain, transport: shared.transport }).extend(permit2Actions());
    expect(await owner.getPermit2Approval({ owner: OWNER.address })).toBe(maxUint256);
    const signed = await owner.signPermit2Transfer({ amount: '0.001', spender: SPENDER.address });
    const r = await spender.permit2TransferFrom({ signed, to: SPENDER.address });
    expect(r.status).toBe('success');
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: shared.sent[0].data! }).functionName).toBe('permitTransferFrom');
  });
});
