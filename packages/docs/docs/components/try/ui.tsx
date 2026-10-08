'use client';

import { useState, type ReactNode } from 'react';
import { addressUrl, createWallet, errorMessage, shortHex, toJson, txUrl, useWallet } from './wallet';

/** Frame shared by the interactive components. */
export function TryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="try-card" aria-label={title}>
      <div className="try-card__header">
        <span className="try-card__title">{title}</span>
        <span className="try-card__badge">Testnet</span>
      </div>
      <div className="try-card__body">{children}</div>
    </section>
  );
}

/** Runs an async action with a busy flag and a captured error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function Button({
  children,
  onClick,
  busy,
  disabled,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? 'try-button try-button--primary' : 'try-button'}
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? (
    <p className="try-message try-message--error" role="alert">
      {error}
    </p>
  ) : null;
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="try-mono">
      {shortHex(hash)}
    </a>
  );
}

export function AddressLink({ address }: { address: string }) {
  return (
    <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="try-mono">
      {shortHex(address)}
    </a>
  );
}

/** Key/value rows. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="try-facts">
      {rows.map(([label, value]) => (
        <div key={label} className="try-facts__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsed raw JSON, for readers who want the whole object. */
export function Raw({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="try-raw">
      <summary>{label}</summary>
      <pre>
        <code>{typeof value === 'string' ? value : toJson(value)}</code>
      </pre>
    </details>
  );
}

/**
 * Renders children once a wallet exists. Before hydration and without a wallet it shows a
 * prompt with a create button, so each component also works on its own.
 */
export function NeedsWallet({ children }: { children: (address: `0x${string}`) => ReactNode }) {
  const wallet = useWallet();
  const { busy, error, run } = useAction();
  if (!wallet.ready) return <p className="try-message">Loading wallet…</p>;
  if (!wallet.address)
    return (
      <>
        <p className="try-message">
          This needs a testnet wallet. Create one here; it is shared with the other examples.
        </p>
        <Button primary busy={busy} onClick={() => run(createWallet)}>
          Create a testnet wallet
        </Button>
        <ErrorLine error={error} />
      </>
    );
  return <>{children(wallet.address)}</>;
}
