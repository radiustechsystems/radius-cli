/**
 * Priced testnet routes for the "Try Radius" components. worker/index.ts charges for
 * them with radius-sdk and the components list them, so both read this one definition.
 */
export const TRY_ROUTES = {
  'GET /api/try/lookup': { price: '0.001 SBC', description: 'Reputation lookup for one IP address' },
  'GET /api/try/report': { price: '0.05 SBC', description: 'Full threat report for one IP address' },
} as const;

export type TryRoute = keyof typeof TRY_ROUTES;
