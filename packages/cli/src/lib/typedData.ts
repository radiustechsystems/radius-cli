import type { TypedDataDefinition } from 'viem';
import { readBodyArg } from './http.js';

type Field = { name: string; type: string };
type Types = Record<string, readonly Field[]>;

/**
 * Read a JSON argument: a literal, `@path` for a file, or `-` for stdin (as `wallet pay -d`).
 * Throws a message that names the flag or argument on a parse error.
 */
export function readJsonArg(arg: string, label: string): unknown {
  const text = new TextDecoder().decode(readBodyArg(arg));
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} must be JSON (a literal, @path or - for stdin): ${(err as Error).message}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toBigInt(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') return value;
  if ((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^(-?\d+|0x[0-9a-fA-F]+)$/.test(value.trim()))) {
    return BigInt(typeof value === 'string' ? value.trim() : value);
  }
  throw new Error(`typed data: ${path} must be an integer (number, decimal string or 0x hex), got ${JSON.stringify(value)}`);
}

/**
 * Integers arrive from JSON as numbers or strings (eth_signTypedData_v4 sends uint256 as strings);
 * viem hashes only numbers and bigints correctly, so convert every (u)int field, through nested
 * structs and arrays, to a bigint.
 */
function coerce(value: unknown, type: string, types: Types, path: string): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    if (!Array.isArray(value)) throw new Error(`typed data: ${path} must be an array (${type})`);
    return value.map((v, i) => coerce(v, array[1], types, `${path}[${i}]`));
  }
  const fields = types[type];
  if (fields) {
    if (!isObject(value)) throw new Error(`typed data: ${path} must be an object (${type})`);
    const out: Record<string, unknown> = { ...value };
    for (const f of fields) {
      if (!(f.name in value)) throw new Error(`typed data: ${path}.${f.name} is missing (${f.type})`);
      out[f.name] = coerce(value[f.name], f.type, types, `${path}.${f.name}`);
    }
    return out;
  }
  if (/^u?int\d*$/.test(type)) return toBigInt(value, path);
  return value;
}

/**
 * Parse EIP-712 typed data in the eth_signTypedData_v4 shape: `{domain, types, primaryType, message}`.
 * `types.EIP712Domain` is optional (viem derives it from `domain`).
 */
export function parseTypedData(input: unknown): TypedDataDefinition {
  if (!isObject(input)) throw new Error('typed data must be a JSON object with domain, types, primaryType and message');
  const { domain = {}, types, primaryType, message } = input;
  if (!isObject(types)) throw new Error('typed data: types must be an object');
  for (const [name, fields] of Object.entries(types)) {
    if (!Array.isArray(fields) || !fields.every((f) => isObject(f) && typeof f.name === 'string' && typeof f.type === 'string')) {
      throw new Error(`typed data: types.${name} must be an array of {name, type}`);
    }
  }
  if (typeof primaryType !== 'string' || !(primaryType in types)) {
    throw new Error(`typed data: primaryType must name one of types (got ${JSON.stringify(primaryType)})`);
  }
  if (primaryType === 'EIP712Domain') throw new Error('typed data: primaryType cannot be EIP712Domain');
  if (!isObject(domain)) throw new Error('typed data: domain must be an object');
  const t = types as Types;
  const d: Record<string, unknown> = { ...domain };
  if (d.chainId !== undefined) d.chainId = Number(toBigInt(d.chainId, 'domain.chainId'));
  return {
    domain: d,
    types: t,
    primaryType,
    message: coerce(message, primaryType, t, 'message') as Record<string, unknown>,
  } as TypedDataDefinition;
}
