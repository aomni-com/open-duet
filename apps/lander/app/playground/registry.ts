/**
 * The lander playground registry — pure metadata, importable from scripts
 * with no JSX. The render map (`render-map.tsx`) is the only place fixtures
 * become elements, and its `satisfies Record<PlaygroundId, …>` keeps the two
 * exhaustively in sync.
 *
 * Every id starts with `lander-` so `bun ui:check <id>` routes the run to
 * this app (`scripts/ui-playground.sh` dispatches on the prefix).
 */

export type LanderPlaygroundGroup = 'chrome' | 'demos' | 'sections' | 'atoms'

export type PlaygroundEntry = {
  readonly id: string
  readonly title: string
  readonly group: LanderPlaygroundGroup
  readonly capture: { readonly kind: 'static' }
  readonly presentation?: 'landing' | 'plain'
}

const STATIC = { kind: 'static' } as const

export const PLAYGROUND_ENTRIES = [
  { id: 'lander-nav', title: 'Landing nav', group: 'chrome', capture: STATIC },
  { id: 'lander-footer', title: 'Landing footer', group: 'chrome', capture: STATIC },
  { id: 'lander-agent-team', title: 'Agent team at work', group: 'demos', capture: STATIC },
  { id: 'lander-primitives', title: 'Platform primitives', group: 'sections', capture: STATIC },
  { id: 'lander-integrations', title: 'Integrations', group: 'sections', capture: STATIC },
  { id: 'lander-share', title: 'Share story', group: 'sections', capture: STATIC },
  // The homepage's own variants: below the fold, so its route shot cannot pin them.
  {
    id: 'lander-home-setup',
    title: 'Home: the stack it replaces',
    group: 'sections',
    capture: STATIC,
  },
  { id: 'lander-home-share', title: 'Home: share three ways', group: 'sections', capture: STATIC },
  {
    id: 'lander-home-integrations',
    title: 'Home: tools only',
    group: 'sections',
    capture: STATIC,
  },
  {
    id: 'lander-problem-silos',
    title: 'Problem — agent silos',
    group: 'sections',
    capture: STATIC,
  },
  {
    id: 'lander-value-props',
    title: 'Why a team, not one agent',
    group: 'sections',
    capture: STATIC,
  },
  { id: 'lander-train', title: 'Train your agent', group: 'sections', capture: STATIC },
  { id: 'lander-collab', title: 'Realtime collaboration', group: 'sections', capture: STATIC },
  { id: 'lander-companies', title: 'For companies cascade', group: 'sections', capture: STATIC },
  { id: 'lander-pricing-tiers', title: 'Pricing plan cards', group: 'sections', capture: STATIC },
  { id: 'lander-faq', title: 'FAQ accordion', group: 'sections', capture: STATIC },
  {
    id: 'lander-final-cta',
    title: 'Final CTA + email capture',
    group: 'sections',
    capture: STATIC,
  },
  { id: 'lander-atoms', title: 'Atoms & primitives', group: 'atoms', capture: STATIC },
  {
    id: 'lander-install-code',
    title: 'Install code example',
    group: 'atoms',
    capture: STATIC,
    presentation: 'plain',
  },
] as const satisfies readonly PlaygroundEntry[]

export type PlaygroundId = (typeof PLAYGROUND_ENTRIES)[number]['id']

export function findPlaygroundEntry(id: string): (typeof PLAYGROUND_ENTRIES)[number] | undefined {
  return PLAYGROUND_ENTRIES.find(entry => entry.id === id)
}
