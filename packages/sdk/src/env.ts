import type { Address, NetworkInput } from './networks.js';

/**
 * Configuration read from environment-style variables, using the same names as
 * radius-cli where they overlap. Spread the result into `radiusPayments()` or
 * `createRadiusFetch()`; explicit options win.
 *
 * | Variable                     | Maps to                     |
 * | ---------------------------- | --------------------------- |
 * | RADIUS_NETWORK               | network ('mainnet' default) |
 * | RADIUS_RPC_URL               | rpcUrl                      |
 * | RADIUS_FACILITATOR_URL       | facilitatorUrl              |
 * | RADIUS_FACILITATOR_API_KEY   | facilitator.apiKey          |
 * | RADIUS_FAUCET_URL            | faucetUrl                   |
 * | RADIUS_ASSET_ADDRESS         | asset.address (payment token; default SBC) |
 * | RADIUS_SBC_ADDRESS           | alias of RADIUS_ASSET_ADDRESS (radius-cli's name) |
 * | RADIUS_PAY_TO                | payTo (server)              |
 * | RADIUS_PRIVATE_KEY           | signer (client)             |
 * | RADIUS_MAX_PER_REQUEST       | maxPerRequest (client)      |
 */
export interface RadiusEnvConfig {
  network: NetworkInput;
  rpcUrl?: string;
  facilitatorUrl?: string;
  facilitator?: { apiKey?: string };
  faucetUrl?: string;
  asset?: { address: Address };
  payTo?: Address;
  signer?: `0x${string}`;
  maxPerRequest?: string;
}

export function radiusEnv(env: Record<string, string | undefined> = defaultEnv()): RadiusEnvConfig {
  const network = env.RADIUS_NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`RADIUS_NETWORK must be 'mainnet' or 'testnet' (got '${network}')`);
  }
  const out: RadiusEnvConfig = { network };
  if (env.RADIUS_RPC_URL) out.rpcUrl = env.RADIUS_RPC_URL;
  if (env.RADIUS_FACILITATOR_URL) out.facilitatorUrl = env.RADIUS_FACILITATOR_URL;
  if (env.RADIUS_FACILITATOR_API_KEY) out.facilitator = { apiKey: env.RADIUS_FACILITATOR_API_KEY };
  if (env.RADIUS_FAUCET_URL) out.faucetUrl = env.RADIUS_FAUCET_URL;
  const assetAddress = env.RADIUS_ASSET_ADDRESS ?? env.RADIUS_SBC_ADDRESS;
  if (assetAddress) out.asset = { address: requireAddress(assetAddress, env.RADIUS_ASSET_ADDRESS ? 'RADIUS_ASSET_ADDRESS' : 'RADIUS_SBC_ADDRESS') };
  if (env.RADIUS_PAY_TO) out.payTo = requireAddress(env.RADIUS_PAY_TO, 'RADIUS_PAY_TO');
  if (env.RADIUS_PRIVATE_KEY) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.RADIUS_PRIVATE_KEY)) throw new Error('RADIUS_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
    out.signer = env.RADIUS_PRIVATE_KEY as `0x${string}`;
  }
  if (env.RADIUS_MAX_PER_REQUEST) out.maxPerRequest = env.RADIUS_MAX_PER_REQUEST;
  return out;
}

function requireAddress(v: string, name: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid 0x address: ${v}`);
  return v as Address;
}

function defaultEnv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}
