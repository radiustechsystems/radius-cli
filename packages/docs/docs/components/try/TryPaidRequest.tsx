'use client';

import { useState, type ReactNode } from 'react';
import type { PaymentReceipt } from 'radius-sdk/client';
import { codeMarkdown } from './markdown';
import { TRY_ROUTES, type TryRoute } from './routes';
import { AddressLink, Button, ErrorLine, Facts, NeedsWallet, Raw, TryCard, TxLink, useAction } from './ui';
import { radiusFetch, refreshBalances, tryApiUrl } from './wallet';

type Offer = {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
};
type Challenge = { x402Version?: number; accepts?: Offer[]; extensions?: Record<string, unknown> };

type Outcome =
  | { kind: 'challenge'; status: number; challenge?: Challenge; body: unknown }
  | { kind: 'paid'; status: number; body: unknown; receipt?: PaymentReceipt; steps: Step[]; elapsedMs: number }
  | { kind: 'refused'; message: string; steps: Step[] };

type Step = { at: number; text: string };

function decodeChallenge(res: Response): Challenge | undefined {
  const header = res.headers.get('payment-required');
  if (!header) return undefined;
  try {
    return JSON.parse(atob(header)) as Challenge;
  } catch {
    return undefined;
  }
}

async function readBody(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function TryPaidRequestCard() {
  const action = useAction();
  const [route, setRoute] = useState<TryRoute>('GET /api/try/lookup');
  const [ip, setIp] = useState('9.9.9.9');
  const [limit, setLimit] = useState('0.01');
  const [outcome, setOutcome] = useState<Outcome>();

  const url = () => {
    const target = new URL(tryApiUrl(route.split(' ')[1].replace('/api/try', '')), location.origin);
    target.searchParams.set('ip', ip.trim() || '0.0.0.0');
    return target.href;
  };

  const requestUnpaid = () =>
    action.run(async () => {
      setOutcome(undefined);
      const res = await fetch(url());
      setOutcome({ kind: 'challenge', status: res.status, challenge: decodeChallenge(res), body: await readBody(res) });
    });

  const pay = () =>
    action.run(async () => {
      setOutcome(undefined);
      const started = performance.now();
      const steps: Step[] = [];
      const step = (text: string) => steps.push({ at: Math.round(performance.now() - started), text });
      const payFetch = await radiusFetch({
        maxPerRequest: `${limit.trim() || '0'} SBC`,
        onPaymentRequired: (offer) => {
          step(
            `Received 402: pay ${offer.amountFormatted} to ${offer.payTo.slice(0, 6)}…${offer.payTo.slice(-4)}` +
              `, within the ${limit} SBC limit. Signing the payment.`,
          );
          return true;
        },
        onApprovalRequired: (request) => {
          step(`Sending a one-time Permit2 approval (allowance ${request.currentAllowance}).`);
          return true;
        },
        onPaid: (receipt) => {
          step(
            `The API settled the payment${receipt.transaction ? ` in ${receipt.transaction.slice(0, 10)}…` : ''} and returned the data.`,
          );
        },
      });
      step('Requested the URL.');
      try {
        const res = await payFetch(url());
        const elapsedMs = Math.round(performance.now() - started);
        const { getPaymentReceipt } = await import('radius-sdk/client');
        setOutcome({
          kind: 'paid',
          status: res.status,
          receipt: getPaymentReceipt(res, payFetch.network),
          body: await readBody(res),
          steps,
          elapsedMs,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'price_above_limit' || code === 'declined') {
          setOutcome({ kind: 'refused', message: (error as Error).message, steps });
          return;
        }
        throw error;
      } finally {
        void refreshBalances();
      }
    });

  const offer = outcome?.kind === 'challenge' ? outcome.challenge?.accepts?.[0] : undefined;

  return (
    <TryCard title="Pay for an API request">
      <div className="try-fields">
        <label>
          <span>Endpoint</span>
          <select className="try-input" value={route} onChange={(e) => setRoute(e.target.value as TryRoute)}>
            {(Object.keys(TRY_ROUTES) as TryRoute[]).map((key) => (
              <option key={key} value={key}>
                {key} ({TRY_ROUTES[key].price})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>IP address</span>
          <input className="try-input try-mono" value={ip} onChange={(e) => setIp(e.target.value)} spellCheck={false} />
        </label>
        <label>
          <span>Your limit per request (SBC)</span>
          <input className="try-input" value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <div className="try-actions">
        <Button busy={action.busy} onClick={requestUnpaid}>
          Request without paying
        </Button>
        <NeedsWallet>
          {() => (
            <Button primary busy={action.busy} onClick={pay}>
              Pay and request
            </Button>
          )}
        </NeedsWallet>
      </div>
      <ErrorLine error={action.error} />

      {outcome?.kind === 'challenge' && (
        <div className="try-result">
          <p className="try-message">
            <strong>
              {outcome.status} {outcome.status === 402 ? 'Payment Required' : ''}
            </strong>
            . The <code>PAYMENT-REQUIRED</code> header carries the offer:
          </p>
          {offer && (
            <Facts
              rows={[
                ['scheme', <code key="s">{offer.scheme}</code>],
                ['network', <code key="n">{offer.network}</code>],
                [
                  'amount',
                  <>
                    <code>{offer.amount}</code> base units (6 decimals)
                  </>,
                ],
                ['asset', offer.asset ? <AddressLink address={offer.asset} /> : '–'],
                ['payTo', offer.payTo ? <AddressLink address={offer.payTo} /> : '–'],
              ]}
            />
          )}
          {outcome.challenge && <Raw label="Decoded PAYMENT-REQUIRED header" value={outcome.challenge} />}
        </div>
      )}

      {(outcome?.kind === 'paid' || outcome?.kind === 'refused') && (
        <div className="try-result">
          <ol className="try-steps">
            {outcome.steps.map((s, i) => (
              <li key={i}>
                <span className="try-steps__time">{s.at} ms</span> {s.text}
              </li>
            ))}
          </ol>
          {outcome.kind === 'refused' && (
            <p className="try-message try-message--warn">
              Refused before signing: {outcome.message}. Nothing was paid. Raise the limit to pay for this endpoint.
            </p>
          )}
          {outcome.kind === 'paid' && (
            <>
              <Facts
                rows={[
                  ['Status', String(outcome.status)],
                  ['Total time', `${outcome.elapsedMs} ms`],
                  ...(outcome.receipt?.transaction
                    ? ([['Settlement', <TxLink key="t" hash={outcome.receipt.transaction} />]] as [string, ReactNode][])
                    : []),
                  ...(outcome.receipt?.payer
                    ? ([['Payer', <AddressLink key="p" address={outcome.receipt.payer} />]] as [string, ReactNode][])
                    : []),
                ]}
              />
              <Raw label="Response body" value={outcome.body} />
              {outcome.receipt && <Raw label="Payment receipt (PAYMENT-RESPONSE header)" value={outcome.receipt} />}
            </>
          )}
        </div>
      )}
    </TryCard>
  );
}

/** Request a priced endpoint without paying (see the 402), then pay for it within a limit. */
export const TryPaidRequest = Object.assign(TryPaidRequestCard, {
  toMarkdown: () =>
    codeMarkdown(
      'Pay for an x402 endpoint within a per-request limit with radius-sdk:',
      'javascript',
      `import { createRadiusFetch, getPaymentReceipt } from 'radius-sdk/client';

const payFetch = createRadiusFetch({ network: 'testnet', signer: process.env.RADIUS_PRIVATE_KEY, maxPerRequest: '0.01 SBC' });
const res = await payFetch('https://docs.radiustech.xyz/api/try/lookup?ip=9.9.9.9'); // 0.001 SBC
console.log(res.status, await res.json(), getPaymentReceipt(res, payFetch.network));
// https://docs.radiustech.xyz/api/try/report costs 0.05 SBC: this client refuses it (price_above_limit).`,
    ),
});
