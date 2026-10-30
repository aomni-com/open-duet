import type { ReactNode } from 'react'

import { InstallCodeBlock } from '@/components/install-code-block'
import { AgentTeamPlayground } from '@/components/playground/agent-team-playground'
import { AtomsPlayground } from '@/components/playground/atoms-playground'
import { FooterPlayground, NavPlayground } from '@/components/playground/chrome-playgrounds'
import {
  CollabSectionPlayground,
  CompaniesSectionPlayground,
  FaqSectionPlayground,
  FinalCtaPlayground,
  HomeIntegrationsPlayground,
  HomeSetupPlayground,
  HomeSharePlayground,
  IntegrationsPlayground,
  PricingTiersPlayground,
  PrimitivesPlayground,
  ProblemSilosPlayground,
  SharePlayground,
  TrainSectionPlayground,
  ValuePropsPlayground,
} from '@/components/playground/section-playgrounds'
import { emailSignInBlock } from '@/src/install-copy'
import { siteConfig } from '@/src/site-config'

import type { PlaygroundId } from './registry'

export const PLAYGROUND_RENDERERS = {
  'lander-nav': () => <NavPlayground />,
  'lander-footer': () => <FooterPlayground />,
  'lander-agent-team': () => <AgentTeamPlayground />,
  'lander-primitives': () => <PrimitivesPlayground />,
  'lander-integrations': () => <IntegrationsPlayground />,
  'lander-share': () => <SharePlayground />,
  'lander-home-setup': () => <HomeSetupPlayground />,
  'lander-home-share': () => <HomeSharePlayground />,
  'lander-home-integrations': () => <HomeIntegrationsPlayground />,
  'lander-problem-silos': () => <ProblemSilosPlayground />,
  'lander-value-props': () => <ValuePropsPlayground />,
  'lander-train': () => <TrainSectionPlayground />,
  'lander-collab': () => <CollabSectionPlayground />,
  'lander-companies': () => <CompaniesSectionPlayground />,
  'lander-pricing-tiers': () => <PricingTiersPlayground />,
  'lander-faq': () => <FaqSectionPlayground />,
  'lander-final-cta': () => <FinalCtaPlayground />,
  'lander-atoms': () => <AtomsPlayground />,
  'lander-install-code': () => (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <InstallCodeBlock block={emailSignInBlock(siteConfig())} />
      </div>
    </div>
  ),
} satisfies Record<PlaygroundId, () => ReactNode>
