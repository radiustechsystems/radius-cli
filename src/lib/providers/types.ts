import type { Address, Hex, LocalAccount } from 'viem';
import type { ResolvedConfig, GlobalOptions } from '../../types.js';

export interface WalletProvider {
  getAccount(cfg: ResolvedConfig): Promise<LocalAccount>;
  getAddress(cfg: ResolvedConfig): Promise<Address>;
  login?(cfg: ResolvedConfig): Promise<void>;
  logout?(cfg: ResolvedConfig): Promise<void>;
  status(cfg: ResolvedConfig, opts: GlobalOptions): Promise<void>;
  exportPrivateKey?(cfg: ResolvedConfig): Promise<Hex>;
}
