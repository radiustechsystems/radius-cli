/**
 * Uniswap Permit2 interactions as viem actions, for the canonical Permit2 contract every
 * Radius network shares (`PERMIT2_ADDRESS`). Two Permit2 flows are covered:
 *
 * SignatureTransfer (what x402 uses): the owner signs a one-off `PermitTransferFrom`
 * (optionally with a witness binding extra data), and the spender submits it with
 * `permitTransferFrom` / `permitWitnessTransferFrom` to pull the tokens. Nonces are unordered
 * 256-bit values tracked in a bitmap; `isPermit2NonceUsed` checks one.
 *
 * AllowanceTransfer (what Uniswap-style apps use): the owner signs a `PermitSingle` granting a
 * spender an amount until an expiration; the spender submits it with `permit` and then moves
 * tokens with `transferFrom` any number of times within the allowance.
 *
 * Both need the owner to have granted Permit2 an ERC-20 allowance once (`approvePermit2`,
 * unlimited by default, the x402 "one-time gas approval" model) unless a facilitator sponsors it.
 *
 *   const owner = createWalletClient({ account, chain, transport: http() }).extend(permit2Actions());
 *   await owner.approvePermit2();                                                  // once per token
 *   const signed = await owner.signPermit2Transfer({ amount: '0.01', spender });   // off-chain
 *   // ...hand `signed` to the spender, who pulls the tokens:
 *   await spender.permit2TransferFrom({ signed, to: spender.account.address });
 */

import { erc20Abi, hashStruct, maxUint160, maxUint256, maxUint48, type Address, type Hex, type TypedDataDomain, type TypedDataParameter } from 'viem';
import { readContract, signTypedData, writeContract } from 'viem/actions';
import { defaultTokens, type BalanceClient } from './balances.js';
import { RadiusPaymentError } from './errors.js';
import { getAllowance, requireAccount, sendAndWait, toTokenAtomic, type TokenAmount, type TokenInput, type TokenWalletClient, type TxResult } from './erc20.js';
import { PERMIT2_ADDRESS } from './networks.js';

/** Default signing window for permits without an explicit deadline (matches the x402 client cap). */
export const PERMIT2_DEFAULT_DEADLINE_SECONDS = 600;

export const PERMIT2_ABI = [
  // SignatureTransfer
  {
    type: 'function',
    name: 'permitTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          { name: 'permitted', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'transferDetails', type: 'tuple', components: [{ name: 'to', type: 'address' }, { name: 'requestedAmount', type: 'uint256' }] },
      { name: 'owner', type: 'address' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'permitWitnessTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          { name: 'permitted', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'transferDetails', type: 'tuple', components: [{ name: 'to', type: 'address' }, { name: 'requestedAmount', type: 'uint256' }] },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'nonceBitmap', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'wordPos', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'invalidateUnorderedNonces', stateMutability: 'nonpayable', inputs: [{ name: 'wordPos', type: 'uint256' }, { name: 'mask', type: 'uint256' }], outputs: [] },
  // AllowanceTransfer
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
  {
    type: 'function',
    name: 'permit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      {
        name: 'permitSingle',
        type: 'tuple',
        components: [
          {
            name: 'details',
            type: 'tuple',
            components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
          },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'token', type: 'address' }],
    outputs: [],
  },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

/** EIP-712 domain of the canonical Permit2 deployment on `chainId`. */
export function permit2Domain(chainId: number): TypedDataDomain {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS };
}

export const TOKEN_PERMISSIONS_TYPE = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const satisfies readonly TypedDataParameter[];

export const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: TOKEN_PERMISSIONS_TYPE,
} as const;

export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const;

/** Extra data a SignatureTransfer permit is bound to (e.g. x402's `Witness(address to,uint256 validAfter)`). */
export interface Permit2Witness {
  /** Name of the witness struct, e.g. `Witness`. */
  typeName: string;
  /** EIP-712 definitions of the witness struct and anything it references. */
  types: Record<string, readonly TypedDataParameter[]>;
  /** The witness value. */
  value: Record<string, unknown>;
}

export interface PermitTransferFrom {
  permitted: { token: Address; amount: bigint };
  nonce: bigint;
  deadline: bigint;
}

/** A signed SignatureTransfer permit: everything the spender needs to call Permit2. */
export interface SignedPermit2Transfer {
  permit: PermitTransferFrom;
  spender: Address;
  owner: Address;
  signature: Hex;
  chainId: number;
  witness?: Permit2Witness;
}

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

/** A signed AllowanceTransfer permit, submitted with `permit2Permit`. */
export interface SignedPermit2Allowance {
  permitSingle: PermitSingle;
  owner: Address;
  signature: Hex;
  chainId: number;
}

export interface Permit2Allowance {
  /** Remaining allowance (uint160). */
  amount: bigint;
  /** Unix seconds after which the allowance is void (uint48). */
  expiration: number;
  /** Next AllowanceTransfer nonce for (owner, token, spender). */
  nonce: number;
}

export interface GetPermit2ApprovalParameters {
  token?: TokenInput;
  owner: Address;
}
export interface GetPermit2AllowanceParameters {
  token?: TokenInput;
  owner: Address;
  spender: Address;
}
export interface IsPermit2NonceUsedParameters {
  owner: Address;
  nonce: bigint;
}
export interface ApprovePermit2Parameters {
  token?: TokenInput;
  /** ERC-20 allowance to grant Permit2. Default: unlimited. */
  amount?: TokenAmount;
  wait?: boolean;
}
export interface SignPermit2TransferParameters {
  token?: TokenInput;
  amount: TokenAmount;
  /** Who may submit the permit (the contract or account that will call Permit2). */
  spender: Address;
  /** Unordered nonce; random by default. */
  nonce?: bigint;
  /** Unix seconds; default now + 600. */
  deadline?: bigint | number;
  witness?: Permit2Witness;
}
export interface SignPermit2AllowanceParameters {
  token?: TokenInput;
  amount: TokenAmount;
  spender: Address;
  /** Unix seconds the allowance lasts until (uint48). */
  expiration: number;
  /** Unix seconds the signature is valid until; default now + 600. */
  sigDeadline?: bigint | number;
  /** AllowanceTransfer nonce; read from Permit2 when omitted. */
  nonce?: number;
}
export interface Permit2TransferFromParameters {
  signed: SignedPermit2Transfer;
  /** Recipient of the tokens. */
  to: Address;
  /** Amount to pull, at most `signed.permit.permitted.amount` (the default). */
  amount?: bigint;
  wait?: boolean;
}
export interface Permit2PermitParameters {
  signed: SignedPermit2Allowance;
  wait?: boolean;
}
export interface Permit2AllowanceTransferFromParameters {
  token?: TokenInput;
  from: Address;
  to: Address;
  amount: TokenAmount;
  wait?: boolean;
}

function tokenAddress(client: BalanceClient, token: TokenInput | undefined): Address {
  const t = token ?? defaultTokens(client)[0];
  return typeof t === 'string' ? t : t.address;
}

function tokenFor(client: BalanceClient, token: TokenInput | undefined): TokenInput {
  return token ?? defaultTokens(client)[0];
}

/** Chain id for EIP-712: the client's chain, else looked up from the node. */
async function chainIdOf(client: BalanceClient): Promise<number> {
  if (client.chain) return client.chain.id;
  const hex = (await client.request({ method: 'eth_chainId' })) as Hex;
  return Number(hex);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toDeadline(v: bigint | number | undefined): bigint {
  if (v === undefined) return BigInt(nowSeconds() + PERMIT2_DEFAULT_DEADLINE_SECONDS);
  const d = BigInt(v);
  if (d <= BigInt(nowSeconds())) throw new RadiusPaymentError('config', `Permit2 deadline ${d} is in the past`);
  return d;
}

/** A random unordered nonce for SignatureTransfer (256 bits). */
export function randomPermit2Nonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/**
 * EIP-712 `encodeType` for `primaryType`: its fields, then every referenced struct sorted by
 * name (the rule Permit2 relies on for its witness type string).
 */
export function encodeTypedDataType(primaryType: string, types: Record<string, readonly TypedDataParameter[]>): string {
  const deps = new Set<string>();
  const visit = (name: string) => {
    if (deps.has(name) || !types[name]) return;
    deps.add(name);
    for (const f of types[name]) visit(f.type.replace(/\[.*\]$/, ''));
  };
  visit(primaryType);
  deps.delete(primaryType);
  const encode = (name: string) => `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(',')})`;
  return encode(primaryType) + [...deps].sort().map(encode).join('');
}

const PERMIT_WITNESS_STUB = 'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';

/** The full EIP-712 types for a witnessed permit: `PermitWitnessTransferFrom` + `TokenPermissions` + the witness structs. */
export function permitWitnessTransferFromTypes(witness: Permit2Witness): Record<string, readonly TypedDataParameter[]> {
  return {
    PermitWitnessTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: witness.typeName },
    ],
    TokenPermissions: TOKEN_PERMISSIONS_TYPE,
    ...witness.types,
  };
}

/**
 * The `witnessTypeString` Permit2 expects in `permitWitnessTransferFrom`: everything after its
 * own `PermitWitnessTransferFrom(...,` stub, e.g.
 * `Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)`.
 */
export function permit2WitnessTypeString(witness: Permit2Witness): string {
  const full = encodeTypedDataType('PermitWitnessTransferFrom', permitWitnessTransferFromTypes(witness));
  if (!full.startsWith(PERMIT_WITNESS_STUB)) throw new RadiusPaymentError('config', 'permit2WitnessTypeString: unexpected type encoding');
  return full.slice(PERMIT_WITNESS_STUB.length);
}

/** `hashStruct` of the witness value, the `witness` argument of `permitWitnessTransferFrom`. */
export function permit2WitnessHash(witness: Permit2Witness): Hex {
  return hashStruct({ primaryType: witness.typeName, types: witness.types, data: witness.value } as Parameters<typeof hashStruct>[0]);
}

// -- reads ----------------------------------------------------------------------------------------

/** ERC-20 allowance the owner has granted to Permit2 (the one-time approval), in atomic units. */
export function getPermit2Approval(client: BalanceClient, args: GetPermit2ApprovalParameters): Promise<bigint> {
  return getAllowance(client, { token: tokenFor(client, args.token), owner: args.owner, spender: PERMIT2_ADDRESS });
}

/** AllowanceTransfer state Permit2 holds for (owner, token, spender). */
export async function getPermit2Allowance(client: BalanceClient, args: GetPermit2AllowanceParameters): Promise<Permit2Allowance> {
  const [amount, expiration, nonce] = await readContract(client, {
    address: PERMIT2_ADDRESS,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [args.owner, tokenAddress(client, args.token), args.spender],
  });
  return { amount, expiration, nonce };
}

/** Whether a SignatureTransfer nonce has been consumed (or invalidated) for `owner`. */
export async function isPermit2NonceUsed(client: BalanceClient, args: IsPermit2NonceUsedParameters): Promise<boolean> {
  const wordPos = args.nonce >> 8n;
  const bit = 1n << (args.nonce & 0xffn);
  const bitmap = await readContract(client, { address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'nonceBitmap', args: [args.owner, wordPos] });
  return (bitmap & bit) !== 0n;
}

// -- owner side -----------------------------------------------------------------------------------

/** ERC-20 `approve(Permit2, amount)` from the client's account; unlimited by default. */
export async function approvePermit2(client: TokenWalletClient, args: ApprovePermit2Parameters = {}): Promise<TxResult> {
  const account = requireAccount(client, 'approvePermit2');
  const token = tokenFor(client, args.token);
  const amount = args.amount === undefined ? maxUint256 : await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: typeof token === 'string' ? token : token.address, abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, amount], account, chain: client.chain }),
  );
}

/**
 * Sign a SignatureTransfer permit (`PermitTransferFrom`, or `PermitWitnessTransferFrom` when a
 * witness is given). Nothing is sent on-chain; hand the result to the spender.
 */
export async function signPermit2Transfer(client: TokenWalletClient, args: SignPermit2TransferParameters): Promise<SignedPermit2Transfer> {
  const account = requireAccount(client, 'signPermit2Transfer');
  const token = tokenFor(client, args.token);
  const [amount, chainId] = await Promise.all([toTokenAtomic(client, token, args.amount), chainIdOf(client)]);
  const permit: PermitTransferFrom = {
    permitted: { token: typeof token === 'string' ? token : token.address, amount },
    nonce: args.nonce ?? randomPermit2Nonce(),
    deadline: toDeadline(args.deadline),
  };
  const domain = permit2Domain(chainId);
  const base = { permitted: permit.permitted, spender: args.spender, nonce: permit.nonce, deadline: permit.deadline };
  const signature = args.witness
    ? await signTypedData(client, {
        account,
        domain,
        types: permitWitnessTransferFromTypes(args.witness),
        primaryType: 'PermitWitnessTransferFrom',
        message: { ...base, witness: args.witness.value },
      } as Parameters<typeof signTypedData>[1])
    : await signTypedData(client, {
        account,
        domain,
        types: PERMIT_TRANSFER_FROM_TYPES,
        primaryType: 'PermitTransferFrom',
        message: base,
      });
  return { permit, spender: args.spender, owner: account.address, signature, chainId, ...(args.witness ? { witness: args.witness } : {}) };
}

/** Sign an AllowanceTransfer `PermitSingle`. The nonce is read from Permit2 unless given. */
export async function signPermit2Allowance(client: TokenWalletClient, args: SignPermit2AllowanceParameters): Promise<SignedPermit2Allowance> {
  const account = requireAccount(client, 'signPermit2Allowance');
  const token = tokenFor(client, args.token);
  const address = typeof token === 'string' ? token : token.address;
  const [amount, chainId, nonce] = await Promise.all([
    toTokenAtomic(client, token, args.amount),
    chainIdOf(client),
    args.nonce ?? getPermit2Allowance(client, { token, owner: account.address, spender: args.spender }).then((a) => a.nonce),
  ]);
  if (amount > maxUint160) throw new RadiusPaymentError('config', `Permit2 allowance amount ${amount} exceeds uint160`);
  if (!Number.isInteger(args.expiration) || args.expiration < 0 || BigInt(args.expiration) > maxUint48) {
    throw new RadiusPaymentError('config', `Permit2 expiration must be a uint48 of unix seconds (got ${args.expiration})`);
  }
  const permitSingle: PermitSingle = {
    details: { token: address, amount, expiration: args.expiration, nonce },
    spender: args.spender,
    sigDeadline: toDeadline(args.sigDeadline),
  };
  const signature = await signTypedData(client, {
    account,
    domain: permit2Domain(chainId),
    types: PERMIT_SINGLE_TYPES,
    primaryType: 'PermitSingle',
    message: permitSingle,
  });
  return { permitSingle, owner: account.address, signature, chainId };
}

// -- spender side ---------------------------------------------------------------------------------

/**
 * Submit a signed SignatureTransfer permit, pulling `amount` (default: all of it) of the owner's
 * tokens to `to`. The client's account must be `signed.spender`.
 */
export async function permit2TransferFrom(client: TokenWalletClient, args: Permit2TransferFromParameters): Promise<TxResult> {
  const account = requireAccount(client, 'permit2TransferFrom');
  const { signed } = args;
  if (account.address.toLowerCase() !== signed.spender.toLowerCase()) {
    throw new RadiusPaymentError('config', `permit2TransferFrom must be sent by the permit's spender ${signed.spender}, not ${account.address}`);
  }
  const requestedAmount = args.amount ?? signed.permit.permitted.amount;
  if (requestedAmount > signed.permit.permitted.amount) {
    throw new RadiusPaymentError('config', `Requested ${requestedAmount} exceeds the permitted ${signed.permit.permitted.amount}`);
  }
  const transferDetails = { to: args.to, requestedAmount };
  return sendAndWait(client, args.wait, () =>
    signed.witness
      ? writeContract(client, {
          address: PERMIT2_ADDRESS,
          abi: PERMIT2_ABI,
          functionName: 'permitWitnessTransferFrom',
          args: [signed.permit, transferDetails, signed.owner, permit2WitnessHash(signed.witness), permit2WitnessTypeString(signed.witness), signed.signature],
          account,
          chain: client.chain,
        })
      : writeContract(client, {
          address: PERMIT2_ADDRESS,
          abi: PERMIT2_ABI,
          functionName: 'permitTransferFrom',
          args: [signed.permit, transferDetails, signed.owner, signed.signature],
          account,
          chain: client.chain,
        }),
  );
}

/** Submit a signed `PermitSingle` so Permit2 records the allowance. Anyone may send it. */
export async function permit2Permit(client: TokenWalletClient, args: Permit2PermitParameters): Promise<TxResult> {
  const account = requireAccount(client, 'permit2Permit');
  const { signed } = args;
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'permit', args: [signed.owner, signed.permitSingle, signed.signature], account, chain: client.chain }),
  );
}

/** AllowanceTransfer `transferFrom`: move tokens within an allowance granted to the client's account. */
export async function permit2AllowanceTransferFrom(client: TokenWalletClient, args: Permit2AllowanceTransferFromParameters): Promise<TxResult> {
  const account = requireAccount(client, 'permit2AllowanceTransferFrom');
  const token = tokenFor(client, args.token);
  const amount = await toTokenAtomic(client, token, args.amount);
  if (amount > maxUint160) throw new RadiusPaymentError('config', `Permit2 transfer amount ${amount} exceeds uint160`);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, {
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: 'transferFrom',
      args: [args.from, args.to, amount, typeof token === 'string' ? token : token.address],
      account,
      chain: client.chain,
    }),
  );
}

// A type alias, not an interface: viem's `client.extend()` needs the implicit index signature.
export type Permit2Actions = {
  getPermit2Approval: (args: GetPermit2ApprovalParameters) => Promise<bigint>;
  getPermit2Allowance: (args: GetPermit2AllowanceParameters) => Promise<Permit2Allowance>;
  isPermit2NonceUsed: (args: IsPermit2NonceUsedParameters) => Promise<boolean>;
  approvePermit2: (args?: ApprovePermit2Parameters) => Promise<TxResult>;
  signPermit2Transfer: (args: SignPermit2TransferParameters) => Promise<SignedPermit2Transfer>;
  signPermit2Allowance: (args: SignPermit2AllowanceParameters) => Promise<SignedPermit2Allowance>;
  permit2TransferFrom: (args: Permit2TransferFromParameters) => Promise<TxResult>;
  permit2Permit: (args: Permit2PermitParameters) => Promise<TxResult>;
  permit2AllowanceTransferFrom: (args: Permit2AllowanceTransferFromParameters) => Promise<TxResult>;
};

export interface Permit2ActionsConfig {
  /** Default token (else the network's payment asset, SBC). */
  token?: TokenInput;
}

/** viem client extension for Permit2. Reads work on any client; the rest need an account. */
export function permit2Actions(config: Permit2ActionsConfig = {}) {
  return (client: TokenWalletClient): Permit2Actions => {
    const withToken = <T extends { token?: TokenInput }>(args: T): T => ({ ...args, token: args.token ?? config.token });
    return {
      getPermit2Approval: (args) => getPermit2Approval(client, withToken(args)),
      getPermit2Allowance: (args) => getPermit2Allowance(client, withToken(args)),
      isPermit2NonceUsed: (args) => isPermit2NonceUsed(client, args),
      approvePermit2: (args = {}) => approvePermit2(client, withToken(args)),
      signPermit2Transfer: (args) => signPermit2Transfer(client, withToken(args)),
      signPermit2Allowance: (args) => signPermit2Allowance(client, withToken(args)),
      permit2TransferFrom: (args) => permit2TransferFrom(client, args),
      permit2Permit: (args) => permit2Permit(client, args),
      permit2AllowanceTransferFrom: (args) => permit2AllowanceTransferFrom(client, withToken(args)),
    };
  };
}
