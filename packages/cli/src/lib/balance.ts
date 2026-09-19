import { hexToBigInt, isAddress, type Address, type Hex, type PublicClient } from 'viem';

/**
 * On Radius, `eth_getBalance` returns native RUSD **plus** convertible stablecoins (SBC)
 * valued 1:1 at 18 decimals, so adding it to an SBC `balanceOf` double-counts the SBC.
 * The EVM's `BALANCE` opcode still sees native RUSD only. `getNativeBalance` reads it
 * through an `eth_call` whose init code is:
 *
 *   PUSH20 <address> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
 *
 * The same logic ships in radius-sdk (`getBalances` / `radiusActions`); the CLI carries a
 * copy because it is published on its own.
 */
export function nativeBalanceBytecode(address: Address): Hex {
  if (!isAddress(address, { strict: false })) throw new Error(`Not a valid address: ${address}`);
  return `0x73${address.slice(2).toLowerCase()}3160005260206000f3`;
}

/** Native RUSD only, in wei (what the EVM sees), as opposed to the aggregate `eth_getBalance` returns. */
export async function getNativeBalance(client: PublicClient, address: Address): Promise<bigint> {
  const result = (await client.request({
    method: 'eth_call',
    params: [{ data: nativeBalanceBytecode(address) }, 'latest'],
  })) as Hex;
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`eth_call returned ${JSON.stringify(result)} instead of a 32-byte word; cannot read the native balance`);
  }
  return hexToBigInt(result);
}

/**
 * Fallback when the node cannot run init code: subtract the SBC holdings (rescaled from
 * `sbcDecimals` to 18) from the aggregate, never below zero.
 */
export function deriveNativeBalance(aggregateWei: bigint, sbcAtomic: bigint, sbcDecimals: number): bigint {
  const scale = 10n ** BigInt(18 - sbcDecimals);
  const convertible = sbcAtomic * scale;
  return aggregateWei > convertible ? aggregateWei - convertible : 0n;
}
