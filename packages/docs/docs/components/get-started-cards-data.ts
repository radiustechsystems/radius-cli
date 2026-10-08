import type { LucideIcon } from 'lucide-react';
import { ArrowLeftRight, Bot, Coins } from 'lucide-react';

export type GetStartedCard = {
  title: string;
  description: string;
  href: string;
  /** Decorative icon. Omitted from generated Markdown. */
  icon: LucideIcon;
  /** Domain names for social-proof favicons. */
  companies?: string[];
  /** Custom label (e.g. "Supported by", "Integrates with"). */
  socialProofLabel?: string;
};

/**
 * Get Started landing cards. Rendered by <GetStartedRow /> and, for the
 * generated Markdown twin / llms-full.txt, by GetStartedRow.toMarkdown.
 */
export const GET_STARTED_CARDS: GetStartedCard[] = [
  {
    title: 'Claim and transact',
    description: 'Claim SBC and send your first transaction with the Dashboard or programmatically.',
    href: '/build/claim-and-transact',
    icon: Coins,
  },
  {
    title: 'Bridge stablecoins',
    description: 'Bridge USDC or SBC from Ethereum or Base to Radius.',
    href: '/build/bridge',
    icon: ArrowLeftRight,
    socialProofLabel: 'Supports',
    companies: ['usdc.com', 'stablecoin.xyz', 'ethereum.org', 'base.org'],
  },
  {
    title: 'Build with LLMs',
    description: 'Use Radius skills and radius-cli to accelerate agent-assisted development.',
    href: '/build/coding-assistants',
    icon: Bot,
    socialProofLabel: 'Integrate with',
    companies: ['claude.ai', 'openai.com', 'anthropic.com', 'cursor.com'],
  },
];
