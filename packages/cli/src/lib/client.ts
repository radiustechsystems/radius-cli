import { createPublicClient, createWalletClient, http, type Account } from 'viem';
import { erc20Actions, radiusActions } from 'radius-sdk/client';
import type { ResolvedConfig } from '../types.js';
import { sbcToken } from './erc20.js';

/**
 * Public client extended with the SDK's balance (`getBalances`, `getTokenBalance`, …) and ERC-20
 * read actions (`getAllowance`, `getTokenMetadata`, `getTransfers`, …). ERC-20 actions default to
 * the configured SBC contract when no `token` is given.
 */
export function makePublicClient(cfg: ResolvedConfig) {
  const token = sbcToken(cfg);
  return createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  })
    .extend(radiusActions({ tokens: [token] }))
    .extend(erc20Actions({ token }));
}

/** Wallet client extended with the SDK's ERC-20 write actions (`transfer`, `approve`, `transferFrom`). */
export function makeWalletClient(cfg: ResolvedConfig, account: Account) {
  return createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  }).extend(erc20Actions({ token: sbcToken(cfg) }));
}
