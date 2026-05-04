import { describe, it, expect } from 'vitest';
import { coerceArg, parseCastSignature } from '../src/lib/signature.js';

describe('parseCastSignature', () => {
  it('parses a write-form signature', () => {
    const r = parseCastSignature('transfer(address,uint256)');
    expect(r.isView).toBe(false);
    expect(r.returnTypes).toEqual([]);
    expect(r.abiItem.name).toBe('transfer');
    expect(r.abiItem.inputs.map((i) => i.type)).toEqual(['address', 'uint256']);
    expect(r.abiItem.stateMutability).toBe('nonpayable');
  });

  it('parses a read-form signature with a single return', () => {
    const r = parseCastSignature('balanceOf(address)(uint256)');
    expect(r.isView).toBe(true);
    expect(r.returnTypes).toEqual(['uint256']);
    expect(r.abiItem.outputs.map((o) => o.type)).toEqual(['uint256']);
    expect(r.abiItem.stateMutability).toBe('view');
  });

  it('parses a read-form signature with multiple returns', () => {
    const r = parseCastSignature('foo(uint256,bytes32)(address,bool)');
    expect(r.isView).toBe(true);
    expect(r.returnTypes).toEqual(['address', 'bool']);
    expect(r.abiItem.inputs.map((i) => i.type)).toEqual(['uint256', 'bytes32']);
    expect(r.abiItem.outputs.map((o) => o.type)).toEqual(['address', 'bool']);
  });

  it('parses tuple inputs without splitting on inner commas', () => {
    const r = parseCastSignature('execute((address,uint256,bytes))');
    expect(r.abiItem.inputs).toHaveLength(1);
    expect(r.abiItem.inputs[0].type).toBe('tuple');
  });

  it('parses tuple returns', () => {
    const r = parseCastSignature('latest()((uint256,address))');
    expect(r.isView).toBe(true);
    expect(r.abiItem.outputs).toHaveLength(1);
    expect(r.abiItem.outputs[0].type).toBe('tuple');
  });

  it('parses zero-arg signatures', () => {
    const r = parseCastSignature('totalSupply()(uint256)');
    expect(r.abiItem.inputs).toEqual([]);
    expect(r.abiItem.outputs[0].type).toBe('uint256');
  });

  it('rejects malformed signatures', () => {
    expect(() => parseCastSignature('badname(')).toThrow();
    expect(() => parseCastSignature('(address)')).toThrow();
    expect(() => parseCastSignature('weird(address)trailing')).toThrow();
  });
});

describe('coerceArg', () => {
  it('coerces uint and int as bigint', () => {
    expect(coerceArg('100', 'uint256')).toBe(100n);
    expect(coerceArg('-7', 'int128')).toBe(-7n);
  });

  it('passes addresses through after validation', () => {
    const a = '0x000000000000000000000000000000000000dEaD';
    expect(coerceArg(a, 'address')).toBe(a);
    expect(() => coerceArg('0xnope', 'address')).toThrow();
  });

  it('coerces bool', () => {
    expect(coerceArg('true', 'bool')).toBe(true);
    expect(coerceArg('false', 'bool')).toBe(false);
    expect(() => coerceArg('maybe', 'bool')).toThrow();
  });

  it('passes string and bytes through', () => {
    expect(coerceArg('hello', 'string')).toBe('hello');
    expect(coerceArg('0xdead', 'bytes')).toBe('0xdead');
  });
});
