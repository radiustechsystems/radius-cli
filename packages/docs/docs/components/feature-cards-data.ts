import type { ComponentType } from 'react';
import { RadiusSwirl1 } from './RadiusSwirl1';
import { RadiusSwirl2 } from './RadiusSwirl2';
import { RadiusSwirl3 } from './RadiusSwirl3';
import { SBCLogo } from './SBCLogo';

export type FeatureCard = {
  title: string;
  description: string;
  href: string;
  /** Decorative icon component. Omitted from generated Markdown. */
  icon?: ComponentType;
};

/**
 * Homepage feature cards. Rendered by <FeatureCards /> and, for the generated
 * Markdown twin / llms-full.txt, by FeatureCards.toMarkdown as a link list.
 */
export const FEATURE_CARDS: FeatureCard[] = [
  {
    title: 'Accept payments',
    description: 'Charge for API routes per request with radius-sdk, settled in SBC on Radius.',
    href: '/build/accept-payments',
    icon: SBCLogo,
  },
  {
    title: 'Make payments',
    description: 'Pay x402 endpoints from an app, agent, or terminal within spending limits you set.',
    href: '/build/make-payments',
    icon: RadiusSwirl1,
  },
  {
    title: 'Reference',
    description: 'radius-sdk, radius-cli, the facilitator API, network settings, fees, and JSON-RPC.',
    href: '/reference',
    icon: RadiusSwirl2,
  },
  {
    title: 'Architecture',
    description: 'How a payment moves through Radius, from authorization to delivery.',
    href: '/architecture',
    icon: RadiusSwirl3,
  },
];
