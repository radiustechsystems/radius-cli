'use client';

import { useState } from 'react';
import type { FaucetResult } from 'radius-sdk/client';
import { codeMarkdown } from './markdown';
import { AddressLink, Button, ErrorLine, Facts, Raw, TryCard, TxLink, useAction } from './ui';
import { createWallet, exportKey, roundAmount, radiusFetch, refreshBalances, resetWallet, useWallet } from './wallet';

function TryWalletCard() {
  const wallet = useWallet();
  const action = useAction();
  const [drip, setDrip] = useState<FaucetResult>();
  const [shownKey, setShownKey] = useState<string>();

  const fund = () =>
    action.run(async () => {
      setDrip(undefined);
      const result = await (await radiusFetch()).fund();
      setDrip(result);
      await refreshBalances();
    });

  if (!wallet.ready)
    return (
      <TryCard title="Testnet wallet">
        <p className="try-message">Loading wallet…</p>
      </TryCard>
    );

  if (!wallet.address)
    return (
      <TryCard title="Testnet wallet">
        <p className="try-message">
          Create a throwaway wallet on Radius Testnet. The private key is generated and kept in this browser, and every
          example in these docs uses it.
        </p>
        <Button primary busy={action.busy} onClick={() => action.run(createWallet)}>
          Create a testnet wallet
        </Button>
        <ErrorLine error={action.error} />
      </TryCard>
    );

  const sbc = wallet.balances?.tokens.find((t) => t.symbol === 'SBC');
  const native = wallet.balances?.native;
  const balance = (value?: string, symbol?: string) =>
    value !== undefined ? `${roundAmount(value)} ${symbol}` : wallet.loadingBalances ? 'Loading…' : '–';
  const native2 = (drip?.raw as { native?: { amount?: string; tx_hash?: string } } | undefined)?.native;

  return (
    <TryCard title="Testnet wallet">
      <Facts
        rows={[
          ['Address', <AddressLink key="a" address={wallet.address} />],
          ['SBC', balance(sbc?.formatted, 'SBC')],
          ['RUSD', balance(native?.rawFormatted, native?.symbol)],
        ]}
      />
      <div className="try-actions">
        <Button primary busy={action.busy} onClick={fund}>
          Get testnet SBC
        </Button>
        <Button disabled={wallet.loadingBalances} onClick={() => void refreshBalances()}>
          Refresh
        </Button>
      </div>
      {drip && (
        <p className="try-message try-message--ok">
          The faucet sent {drip.amount} SBC
          {drip.txHash && (
            <>
              {' '}
              in <TxLink hash={drip.txHash} />
            </>
          )}
          {native2?.amount && (
            <>
              {' '}
              and {native2.amount} RUSD
              {native2.tx_hash && (
                <>
                  {' '}
                  in <TxLink hash={native2.tx_hash} />
                </>
              )}
            </>
          )}
          .
        </p>
      )}
      <ErrorLine error={action.error ?? wallet.balancesError} />
      <details className="try-raw">
        <summary>Private key</summary>
        <p className="try-message">
          The key is stored in this browser&apos;s local storage. Use it for testnet only, for example with{' '}
          <code>RADIUS_PRIVATE_KEY</code> in the tutorials.
        </p>
        <div className="try-actions">
          <Button onClick={() => setShownKey(shownKey ? undefined : exportKey())}>
            {shownKey ? 'Hide private key' : 'Show private key'}
          </Button>
          <Button
            onClick={() => {
              if (confirm('Delete this testnet wallet? Its key cannot be recovered.')) {
                setShownKey(undefined);
                setDrip(undefined);
                void resetWallet();
              }
            }}
          >
            Delete wallet
          </Button>
        </div>
        {shownKey && <pre className="try-mono try-key">{shownKey}</pre>}
      </details>
      {wallet.balances && <Raw label="balances() result" value={wallet.balances} />}
    </TryCard>
  );
}

/**
 * Create, fund and inspect the shared testnet wallet. In agent Markdown it becomes the
 * equivalent radius-sdk script.
 */
export const TryWallet = Object.assign(TryWalletCard, {
  toMarkdown: () =>
    codeMarkdown(
      'Create and fund a testnet wallet with radius-sdk:',
      'javascript',
      `import { createRadiusFetch } from 'radius-sdk/client';
import { generatePrivateKey } from 'viem/accounts';

const payFetch = createRadiusFetch({ network: 'testnet', signer: generatePrivateKey(), maxPerRequest: '0.01 SBC' });
console.log('wallet', payFetch.address);
console.log(await payFetch.fund()); // 0.5 SBC and 0.001 RUSD from the testnet faucet
console.log(await payFetch.balances());`,
    ),
});
