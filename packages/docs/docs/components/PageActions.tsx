'use client';

import { useEffect, useState } from 'react';
import { ClipboardCopy } from 'lucide-react';

/**
 * "View as Markdown" and "Copy for LLM" below each page title. Inserted by
 * `docs/rehype-page-actions.ts`, which passes the page's Markdown twin URL, so
 * pages do not import it themselves.
 */
export function PageActions({ markdownHref }: { markdownHref: string }) {
  const [copyLabel, setCopyLabel] = useState('Copy for LLM');
  const [markdown, setMarkdown] = useState<string | null>(null);

  // Prefetch so the click can write to the clipboard synchronously; Safari
  // rejects clipboard writes that happen after an awaited fetch.
  useEffect(() => {
    let cancelled = false;
    fetch(markdownHref)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => !cancelled && text && setMarkdown(text))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [markdownHref]);

  const showLabel = (label: string, ms: number) => {
    setCopyLabel(label);
    setTimeout(() => setCopyLabel('Copy for LLM'), ms);
  };

  const handleCopy = async () => {
    try {
      let text = markdown;
      if (!text) {
        const response = await fetch(markdownHref);
        if (!response.ok) throw new Error(`Failed to fetch ${markdownHref}`);
        text = await response.text();
      }
      await navigator.clipboard.writeText(text);
      showLabel('Copied', 1200);
    } catch (error) {
      console.error('Copy failed:', error);
      showLabel('Unable to copy', 1600);
    }
  };

  return (
    <div className="page-actions">
      <a className="page-actions__link" href={markdownHref}>
        <MarkdownIcon />
        <span>View as Markdown</span>
      </a>
      <button className="page-actions__button" onClick={handleCopy} type="button">
        <ClipboardCopy size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span aria-live="polite">{copyLabel}</span>
      </button>
    </div>
  );
}

function MarkdownIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="-10 -5 1034 1034"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M922 319q-1 0 -2 1h-11v0h-836q-18 0 -33.5 8.5t-25.5 22.5q-17 26 -13 57v461q1 18 11 32.5t24 22.5q25 14 55 10v1l843 -1q18 -1 32.5 -11t22.5 -24q14 -24 10 -55h1l-1 -459q-1 -17 -11 -31.5t-24 -23.5q-19 -10 -42 -11zM918 367h2q12 0 20 5q6 3 8.5 6.5t2.5 9.5l1 456v3q2 16 -5 29q-3 5 -6.5 7.5t-9.5 2.5l-840 1h-3q-16 2 -28 -5q-6 -3 -8.5 -6.5t-2.5 -9.5v-458l-1 -4q-2 -14 5.5 -25t18.5 -11h837zM145 464v327h96v-188l96 120l96 -120v188h96v-327h-96l-96 120l-96 -120h-96zM697 464v168h-96l144 159l144 -159h-96v-168h-96z" />
    </svg>
  );
}
