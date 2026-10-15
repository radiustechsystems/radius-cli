import type { AstroIntegration } from 'astro';
import type { MiddlewareConfig } from './handler.js';
import type { PaidAccessOptions } from './core.js';

export { createPaidAccess, matchesPath } from './core.js';
export type { EnforceOptions, EnforceResult, PaidAccess, PaidAccessOptions } from './core.js';
export type { MiddlewareConfig } from './handler.js';

export interface RadiusPaidAccessOptions extends Pick<PaidAccessOptions, 'payTo' | 'network' | 'defaultPrice' | 'description' | 'botOnly' | 'botScoreThreshold'> {
  /**
   * Paths to charge before the page renders. A key is an exact path or a pattern with `*`
   * ("/posts/*"); a value is that path's price, or `null` for `defaultPrice`. Leave empty to charge
   * nothing automatically and call `Astro.locals.radiusPaidAccess.enforce()` in pages instead.
   */
  routes?: Record<string, string | number | null> | string[];
}

const PACKAGE = 'radius-emdash-paid-access';
const VIRTUAL_ID = `virtual:${PACKAGE}/config`;
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * Charge AI agents per request, in stablecoin over x402 on Radius, for an EmDash or Astro site.
 * Needs `output: 'server'` (or a server-rendered route) and an adapter.
 *
 * ```js
 * export default defineConfig({
 *   integrations: [radiusPaidAccess({ payTo: '0x…', network: 'mainnet', routes: { '/posts/*': '$0.01' } })],
 * });
 * ```
 */
export default function radiusPaidAccess(options: RadiusPaidAccessOptions): AstroIntegration {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.payTo)) throw new Error(`${PACKAGE}: payTo must be a 0x address`);
  const routes = Array.isArray(options.routes) ? Object.fromEntries(options.routes.map((r) => [r, null])) : (options.routes ?? {});
  const config: MiddlewareConfig = { ...options, routes };

  return {
    name: PACKAGE,
    hooks: {
      'astro:config:setup': ({ addMiddleware, updateConfig }) => {
        updateConfig({
          vite: {
            // The middleware imports the virtual config module, so Vite must bundle it instead of
            // leaving it as an external package import it cannot resolve.
            ssr: { noExternal: [PACKAGE] },
            plugins: [
              {
                name: `${PACKAGE}-config`,
                resolveId: (id: string) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
                load: (id: string) => (id === RESOLVED_ID ? `export default ${JSON.stringify(config)};` : undefined),
              },
            ],
          },
        });
        addMiddleware({ entrypoint: `${PACKAGE}/middleware`, order: 'pre' });
      },
    },
  };
}
