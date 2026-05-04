import { createPublicClient, createWalletClient, http, type Account } from 'viem';
import type { ResolvedConfig } from '../types.js';

export function makePublicClient(cfg: ResolvedConfig) {
  return createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });
}

export function makeWalletClient(cfg: ResolvedConfig, account: Account) {
  return createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });
}
