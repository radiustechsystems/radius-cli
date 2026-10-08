/**
 * Static formatting for <TransactionCost /> values.
 *
 * Shared by the React component (SSR fallback) and by the Markdown output
 * plugin (docs/remark-llm-output.ts) so that the generated .md twins and
 * llms-full.txt show exactly the value humans see before hydration.
 */
import { TX_FEE, GAS_PRICE, GAS_USED } from '../constants.js';

export type TransactionCostField = 'cost_usd' | 'gas_price_wei' | 'gas_used';
export type TransactionCostFormat = 'usd' | 'wei' | 'raw';

export function getStaticFallback(
  field: TransactionCostField = 'cost_usd',
  format: TransactionCostFormat = 'usd',
  explicitFallback?: string,
): string {
  if (explicitFallback) return explicitFallback;

  switch (field) {
    case 'cost_usd':
      return TX_FEE;
    case 'gas_price_wei':
      if (format === 'usd') return `${GAS_PRICE} RUSD`;
      return GAS_PRICE;
    case 'gas_used':
      return String(GAS_USED);
    default:
      return TX_FEE;
  }
}
