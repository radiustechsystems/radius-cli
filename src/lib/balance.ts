/**
 * Split an aggregate `eth_getBalance` result into its SBC and raw-native parts.
 *
 * Radius RPC semantics change (2026-06): `eth_getBalance` now returns
 * `token_balance × per_unit_exchange_rate + raw_native` — no floor rounding,
 * no per-transaction cap. The SBC token balance is therefore already included
 * in the native balance, so summing `eth_getBalance + balanceOf(SBC)` double
 * counts.
 *
 * Assuming the stablecoin peg (1 SBC = 1 native unit = $1), the raw native
 * (RUSD) portion is the aggregate minus the SBC balance scaled to wei,
 * clamped at zero in case the exchange rate ever drifts below peg.
 */
export function splitAggregateBalance(args: {
  /** result of eth_getBalance (wei, 18 decimals) */
  aggregateWei: bigint;
  /** result of SBC balanceOf (token units) */
  sbcRaw: bigint;
  /** SBC token decimals */
  sbcDecimals: number;
}): { totalWei: bigint; sbcAsWei: bigint; nativeWei: bigint } {
  const scale = 10n ** BigInt(18 - args.sbcDecimals);
  const sbcAsWei = args.sbcRaw * scale;
  const nativeWei = args.aggregateWei > sbcAsWei ? args.aggregateWei - sbcAsWei : 0n;
  return { totalWei: args.aggregateWei, sbcAsWei, nativeWei };
}
