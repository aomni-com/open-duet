import type { VisualCoverageEntry } from '../../../../scripts/visual-coverage-core'

/**
 * Explicit owners. Playground fixtures own the reusable lander building
 * blocks (each fixture's import closure follows automatically); everything
 * else stays route-owned via the generated ledger, which follows every
 * representative manifest route through its real page/layout import closure.
 */
export const VISUAL_COVERAGE: readonly VisualCoverageEntry[] = [
  {
    target: 'components/install-code-block.tsx#InstallCodeBlock',
    kind: 'fixture',
    fixture: 'lander-install-code',
  },
  {
    target: 'components/playground/chrome-playgrounds.tsx#NavPlayground',
    kind: 'fixture',
    fixture: 'lander-nav',
  },
  {
    target: 'components/playground/chrome-playgrounds.tsx#FooterPlayground',
    kind: 'fixture',
    fixture: 'lander-footer',
  },
  {
    target: 'components/playground/agent-team-playground.tsx#AgentTeamPlayground',
    kind: 'fixture',
    fixture: 'lander-agent-team',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#PrimitivesPlayground',
    kind: 'fixture',
    fixture: 'lander-primitives',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#IntegrationsPlayground',
    kind: 'fixture',
    fixture: 'lander-integrations',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#SharePlayground',
    kind: 'fixture',
    fixture: 'lander-share',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#ProblemSilosPlayground',
    kind: 'fixture',
    fixture: 'lander-problem-silos',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#ValuePropsPlayground',
    kind: 'fixture',
    fixture: 'lander-value-props',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#TrainSectionPlayground',
    kind: 'fixture',
    fixture: 'lander-train',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#CollabSectionPlayground',
    kind: 'fixture',
    fixture: 'lander-collab',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#CompaniesSectionPlayground',
    kind: 'fixture',
    fixture: 'lander-companies',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#FaqSectionPlayground',
    kind: 'fixture',
    fixture: 'lander-faq',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#PricingTiersPlayground',
    kind: 'fixture',
    fixture: 'lander-pricing-tiers',
  },
  {
    target: 'components/playground/section-playgrounds.tsx#FinalCtaPlayground',
    kind: 'fixture',
    fixture: 'lander-final-cta',
  },
  {
    target: 'components/playground/atoms-playground.tsx#AtomsPlayground',
    kind: 'fixture',
    fixture: 'lander-atoms',
  },
]
