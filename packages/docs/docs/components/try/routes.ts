/**
 * Priced testnet routes for the "Try Radius" components. worker/index.ts charges for
 * them with radius-sdk and the components list them, so both read this one definition.
 */
export const TRY_ROUTES = {
  'GET /api/try/hello': { price: '0.001 SBC', description: 'A Hello, world! message' },
} as const;
