'use client';

import { useEffect, useState } from 'react';
import { codeMarkdown } from './markdown';
import { AddressLink, Button, ErrorLine, Facts, NeedsWallet, TryCard, TxLink, useAction } from './ui';
import { radiusFetch, refreshBalances, roundAmount, tryApiUrl } from './wallet';

type SendResult = {
  hash: `0x${string}`;
  status: string;
  to: `0x${string}`;
  amount: string;
  elapsedMs: number;
  /** Fee in RUSD (18 decimals), from the receipt. */
  fee?: string;
};

function TrySendCard() {
  const action = useAction();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [result, setResult] = useState<SendResult>();

  // Default recipient: the docs API's payee (TRY_PAY_TO), the testnet faucet wallet.
  useEffect(() => {
    fetch(tryApiUrl('/info'))
      .then((res) => res.json() as Promise<{ payTo?: string }>)
      .then((info) => setTo((current) => current || info.payTo || ''))
      .catch(() => {});
  }, []);

  const send = () =>
    action.run(async () => {
      setResult(undefined);
      if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) throw new Error('Enter a 0x… address with 40 hex characters.');
      const payFetch = await radiusFetch();
      const started = performance.now();
      const tx = await payFetch.send(to.trim() as `0x${string}`, `${amount} SBC`);
      const elapsedMs = Math.round(performance.now() - started);
      const [{ createPublicClient, http, formatEther }] = await Promise.all([import('viem')]);
      const client = createPublicClient({ chain: payFetch.network.chain, transport: http() });
      const receipt = await client.getTransactionReceipt({ hash: tx.hash }).catch(() => undefined);
      setResult({
        hash: tx.hash,
        status: tx.status,
        to: to.trim() as `0x${string}`,
        amount,
        elapsedMs,
        fee: receipt ? roundAmount(formatEther(receipt.gasUsed * receipt.effectiveGasPrice)) : undefined,
      });
      await refreshBalances();
    });

  return (
    <TryCard title="Send SBC">
      <NeedsWallet>
        {() => (
          <>
            <div className="try-fields">
              <label>
                <span>To</span>
                <input
                  className="try-input try-mono"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Amount (SBC)</span>
                <input
                  className="try-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
            <div className="try-actions">
              <Button primary busy={action.busy} onClick={send}>
                Send
              </Button>
            </div>
            <ErrorLine error={action.error} />
            {result && (
              <Facts
                rows={[
                  ['Transaction', <TxLink key="t" hash={result.hash} />],
                  ['Status', result.status],
                  [
                    'Sent',
                    <>
                      {result.amount} SBC to <AddressLink address={result.to} />
                    </>,
                  ],
                  ['Sent and confirmed in', `${result.elapsedMs} ms`],
                  ...(result.fee ? ([['Fee', `${result.fee} RUSD`]] as [string, string][]) : []),
                ]}
              />
            )}
          </>
        )}
      </NeedsWallet>
    </TryCard>
  );
}

/** Send SBC from the shared testnet wallet and show the confirmation time and fee. */
export const TrySend = Object.assign(TrySendCard, {
  toMarkdown: () =>
    codeMarkdown(
      'Send SBC from a funded testnet wallet with radius-sdk:',
      'javascript',
      `import { createRadiusFetch } from 'radius-sdk/client';

const payFetch = createRadiusFetch({ network: 'testnet', signer: process.env.RADIUS_PRIVATE_KEY, maxPerRequest: '0.01 SBC' });
const tx = await payFetch.send('0xRecipientAddress', '0.01 SBC'); // waits for the receipt
console.log(tx.status, tx.explorerUrl);`,
    ),
});
