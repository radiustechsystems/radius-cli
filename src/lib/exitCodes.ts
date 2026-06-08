/**
 * Process exit codes for agent-friendly error handling.
 *
 * Agents can switch on the exit code to determine the failure category
 * without parsing error text.
 */

/** Command completed successfully. */
export const EXIT_SUCCESS = 0;

/** General / uncategorized error. */
export const EXIT_GENERAL_ERROR = 1;

/** Invalid CLI usage: bad arguments, unsupported verb, missing required input. */
export const EXIT_USAGE = 2;

/** Configuration error: missing env var, invalid config file, bad provider setup. */
export const EXIT_CONFIG = 3;

/** Authentication / authorization error: not logged in, invalid key, wallet not found. */
export const EXIT_AUTH = 4;

/** Network / RPC error: unreachable endpoint, transaction failed, exec reverted. */
export const EXIT_NETWORK = 5;

/** Insufficient balance for the requested operation. */
export const EXIT_BALANCE = 6;

/** Payment declined or failed (x402 specific). */
export const EXIT_PAYMENT = 7;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
