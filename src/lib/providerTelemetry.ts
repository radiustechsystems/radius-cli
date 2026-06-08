import type { WalletProviderName } from '../types.js';

function setEnvDefault(key: string, value: string): void {
  process.env[key] ??= value;
}

export function disableProviderTelemetry(provider: WalletProviderName): void {
  switch (provider) {
    case 'cdp':
      setEnvDefault('DISABLE_CDP_ERROR_REPORTING', 'true');
      setEnvDefault('DISABLE_CDP_USAGE_TRACKING', 'true');
      break;
    case 'para':
      setEnvDefault('OTEL_SDK_DISABLED', 'true');
      setEnvDefault('OTEL_TRACES_EXPORTER', 'none');
      break;
    case 'privy':
    case 'keystore':
      break;
  }
}
