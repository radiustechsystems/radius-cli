'use client';

import { useState, useEffect } from 'react';
import { TESTNET_DASHBOARD_URL, TRANSACTION_COST_API_PATH } from '../constants';
import { getStaticFallback, type TransactionCostField, type TransactionCostFormat } from './transaction-cost-format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransactionCostData {
  cost_usd: number;
  gas_price_wei: string;
  gas_used: number;
  last_updated: number;
}

type FieldName = TransactionCostField;
type FormatType = TransactionCostFormat;

interface TransactionCostProps {
  /** Which API field to display. Defaults to `'cost_usd'`. */
  field?: FieldName;
  /** How to format the value. Defaults to `'usd'`. */
  format?: FormatType;
  /** Static fallback rendered during SSR and on fetch failure. */
  fallback?: string;
}

// ---------------------------------------------------------------------------
// Module-level cache — shared across all component instances
// ---------------------------------------------------------------------------

let cachedData: TransactionCostData | null = null;
let cacheTimestamp = 0;
let inflight: Promise<TransactionCostData | null> | null = null;

const CACHE_TTL_MS = 60_000; // refresh every 60 seconds
const FETCH_TIMEOUT_MS = 5_000;

async function fetchTransactionCost(): Promise<TransactionCostData | null> {
  const now = Date.now();

  // Return cached value if still fresh
  if (cachedData && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedData;
  }

  // Deduplicate concurrent requests
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(`${TESTNET_DASHBOARD_URL}${TRANSACTION_COST_API_PATH}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return cachedData;

      const data = (await res.json()) as TransactionCostData;

      // Basic shape validation
      if (
        typeof data.cost_usd !== 'number' ||
        typeof data.gas_price_wei !== 'string' ||
        typeof data.gas_used !== 'number'
      ) {
        return cachedData;
      }

      cachedData = data;
      cacheTimestamp = Date.now();
      return data;
    } catch {
      // Network error, CORS block, timeout — return stale cache or null
      return cachedData;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatCostUsd(cost: number): string {
  if (cost <= 0) return '0 USD';

  // Find leading zeros to determine appropriate decimal places
  const fixed = cost.toFixed(20);
  const dotIdx = fixed.indexOf('.');
  let firstNonZero = -1;
  for (let i = dotIdx + 1; i < fixed.length; i++) {
    if (fixed[i] !== '0') {
      firstNonZero = i;
      break;
    }
  }

  if (firstNonZero === -1) return '0 USD';

  const leadingZeros = firstNonZero - dotIdx - 1;
  const decimalPlaces = leadingZeros + 2;
  return `${cost.toFixed(decimalPlaces)} USD`;
}

function formatGasPriceWei(hexWei: string): string {
  const wei = BigInt(hexWei);
  return `${wei.toString()} wei`;
}

function formatFieldValue(data: TransactionCostData, field: FieldName, format: FormatType): string {
  switch (field) {
    case 'cost_usd':
      return format === 'raw' ? String(data.cost_usd) : formatCostUsd(data.cost_usd);

    case 'gas_price_wei':
      if (format === 'wei') return formatGasPriceWei(data.gas_price_wei);
      if (format === 'raw') return data.gas_price_wei;
      // 'usd' — convert to RUSD
      return `${(Number(BigInt(data.gas_price_wei)) / 1e18).toPrecision(9)} RUSD`;

    case 'gas_used':
      return data.gas_used.toLocaleString('en-US');

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a live transaction cost value fetched from the Radius Network API.
 *
 * During SSR and before the client-side fetch completes, displays the static
 * fallback from `docs/constants.ts` (updated at build-time). Once the API
 * responds, the displayed value updates to reflect live network data.
 *
 * Generated Markdown (.md twins, llms-full.txt) always shows the static value;
 * see docs/remark-llm-output.ts.
 *
 * Usage in MDX:
 * ```
 * <TransactionCost />                                     → "0.000093 USD"
 * <TransactionCost field="gas_price_wei" format="wei" />  → "985998816 wei"
 * <TransactionCost field="gas_used" />                    → "94,206"
 * ```
 */
export function TransactionCost({ field = 'cost_usd', format = 'usd', fallback }: TransactionCostProps) {
  const staticValue = getStaticFallback(field, format, fallback);
  const [display, setDisplay] = useState(staticValue);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchTransactionCost().then((data) => {
      if (cancelled || !data) return;
      const formatted = formatFieldValue(data, field, format);
      if (formatted) {
        setDisplay(formatted);
        setIsLive(true);
      }
    });

    // Set up a refresh interval
    const interval = setInterval(() => {
      // Invalidate cache so the next fetch gets fresh data
      cacheTimestamp = 0;
      fetchTransactionCost().then((data) => {
        if (cancelled || !data) return;
        const formatted = formatFieldValue(data, field, format);
        if (formatted) {
          setDisplay(formatted);
          setIsLive(true);
        }
      });
    }, CACHE_TTL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [field, format]);

  return (
    <span
      title={isLive ? 'Live from network' : 'Static value (updated at build-time)'}
      style={{
        borderBottom: isLive ? '1px dotted currentColor' : undefined,
        cursor: isLive ? 'help' : undefined,
      }}
    >
      {display}
    </span>
  );
}
