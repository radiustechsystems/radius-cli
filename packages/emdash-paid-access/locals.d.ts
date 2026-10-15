import type { PaidAccess } from './dist/core.js';

declare global {
  namespace App {
    interface Locals {
      /** Set by the `radius-emdash-paid-access` middleware on every request. */
      radiusPaidAccess: PaidAccess;
    }
  }
}

export {};
