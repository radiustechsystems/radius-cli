#!/usr/bin/env tsx
/**
 * fetch-transaction-cost.ts
 *
 * Fetches live transaction cost data from the Radius Network API and updates
 * the TX_FEE, GAS_PRICE, and GAS_USED constants in docs/constants.ts.
 *
 * Runs as a prebuild step so that static docs and LLM markdown always reflect
 * current network fees. If the fetch fails, existing values are preserved and
 * the build continues.
 *
 * Usage:
 *   npx tsx scripts/fetch-transaction-cost.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dirname ?? dirname(new URL(import.meta.url).pathname);
const CONSTANTS_PATH = join(SCRIPT_DIR, '..', 'docs', 'constants.ts');

// Use testnet API (publicly accessible, no Cloudflare Access gate)
const API_URL = 'https://testnet.radiustech.xyz/api/v1/network/transaction-cost';

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransactionCostResponse {
  cost_usd: number;
  gas_price_wei: string; // hex-encoded, e.g. "0x3ac525e0"
  gas_used: number;
  last_updated: number; // unix timestamp in milliseconds
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a USD cost value to a reasonable number of significant digits.
 * Examples:
 *   0.000092887004460096 → "0.000093"
 *   0.0001              → "0.0001"
 *   0.00432             → "0.00432"
 */
function formatCostUsd(cost: number): string {
  if (cost <= 0) return '0 USD';

  // Find the number of leading zeros after the decimal point
  const str = cost.toFixed(20);
  const dotIndex = str.indexOf('.');
  let firstNonZero = -1;
  for (let i = dotIndex + 1; i < str.length; i++) {
    if (str[i] !== '0') {
      firstNonZero = i;
      break;
    }
  }

  if (firstNonZero === -1) return '0 USD';

  // Show 2 significant digits for the fractional part
  const leadingZeros = firstNonZero - dotIndex - 1;
  const decimalPlaces = leadingZeros + 2;
  const rounded = cost.toFixed(decimalPlaces);

  return `${rounded} USD`;
}

/**
 * Convert a hex gas price in wei to a scientific-notation string in RUSD
 * (18-decimal native token).
 *
 * Example: "0x3ac525e0" → 985998816 wei → "9.85998816e-10"
 */
function gasPriceWeiToRusd(hexWei: string): string {
  const wei = BigInt(hexWei);
  // Convert to a float for display. At these magnitudes (< 10^10 wei),
  // Number precision is more than sufficient.
  const rusd = Number(wei) / 1e18;
  return rusd.toPrecision(9);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('⏳ Fetching live transaction cost from network API...');
  console.log(`   URL: ${API_URL}`);

  let data: TransactionCostResponse;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(API_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    data = (await response.json()) as TransactionCostResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠  Failed to fetch transaction cost: ${message}`);
    console.warn('   Keeping existing constants.ts values.');
    return;
  }

  // Validate response shape
  if (
    typeof data.cost_usd !== 'number' ||
    typeof data.gas_price_wei !== 'string' ||
    typeof data.gas_used !== 'number'
  ) {
    console.warn('⚠  Unexpected API response shape:', JSON.stringify(data));
    console.warn('   Keeping existing constants.ts values.');
    return;
  }

  console.log(`   cost_usd:      ${data.cost_usd}`);
  console.log(`   gas_price_wei:  ${data.gas_price_wei}`);
  console.log(`   gas_used:       ${data.gas_used}`);
  console.log(`   last_updated:   ${new Date(data.last_updated).toISOString()}`);

  // Compute formatted values
  const txFee = formatCostUsd(data.cost_usd);
  const gasPrice = gasPriceWeiToRusd(data.gas_price_wei);
  const gasUsed = data.gas_used;

  console.log('');
  console.log(`   TX_FEE    → '${txFee}'`);
  console.log(`   GAS_PRICE → '${gasPrice}'`);
  console.log(`   GAS_USED  → ${gasUsed}`);

  // Read constants.ts and replace the block between markers
  let source: string;
  try {
    source = readFileSync(CONSTANTS_PATH, 'utf-8');
  } catch (err) {
    console.error(`✗  Could not read ${CONSTANTS_PATH}:`, err);
    process.exit(1);
  }

  const START_MARKER = '// @tx-cost-start';
  const END_MARKER = '// @tx-cost-end';

  const startIdx = source.indexOf(START_MARKER);
  const endIdx = source.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error('✗  Could not find @tx-cost-start / @tx-cost-end markers in constants.ts');
    console.error('   Ensure the markers exist. Keeping existing values.');
    return;
  }

  const newBlock = [
    START_MARKER,
    `export const TX_FEE = '${txFee}';`,
    `export const GAS_PRICE = '${gasPrice}';`,
    `export const GAS_USED = ${gasUsed};`,
    END_MARKER,
  ].join('\n');

  const updated = source.slice(0, startIdx) + newBlock + source.slice(endIdx + END_MARKER.length);

  writeFileSync(CONSTANTS_PATH, updated, 'utf-8');
  console.log('');
  console.log('✓  Updated docs/constants.ts with live transaction cost data.');
}

main().catch((err) => {
  console.error('✗  Unexpected error:', err);
  // Don't fail the build — keep existing values
});
