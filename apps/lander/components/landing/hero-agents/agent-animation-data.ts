import type { AgentDef, OutputState, PairId, TimelineStep, WorkstreamDef } from './types'

export const DUET_AGENT: AgentDef = {
  id: 'duet',
  name: 'Duet',
  color: '#6C9CFF',
  orbColors: {
    c1: 'oklch(72% 0.18 250)',
    c2: 'oklch(78% 0.14 210)',
    c3: 'oklch(68% 0.16 280)',
  },
}

export const WORKSTREAMS: WorkstreamDef[] = [
  {
    id: 'ws-pipeline',
    label: 'GTM',
    color: '#34D399',
    outputId: 'dashboard',
    pairId: 'pair-1',
    statusMessages: [
      'Pulling pipeline data...',
      'Analyzing conversion rates...',
      'Building dashboard...',
    ],
  },
  {
    id: 'ws-prd',
    label: 'Product',
    color: '#A78BFA',
    outputId: 'prd',
    pairId: 'pair-1',
    statusMessages: ['Reviewing requirements...', 'Analyzing market size...', 'Drafting PRD...'],
  },
  {
    id: 'ws-email',
    label: 'Ops',
    color: '#6C9CFF',
    outputId: 'email',
    pairId: 'pair-2',
    statusMessages: ['Checking calendar...', 'Composing email...', 'Adding attachments...'],
  },
  {
    id: 'ws-social',
    label: 'Social',
    color: '#F59E0B',
    outputId: 'social',
    pairId: 'pair-2',
    statusMessages: ['Designing layout...', 'Writing copy...', 'Scheduling post...'],
  },
]

export const STATION_ICONS: Record<string, string> = {
  slack: '/landing/integrations/slack.png',
  github: '/landing/integrations/github.png',
  notion: '/landing/integrations/notion.png',
  gmail: '/landing/integrations/gmail.webp',
  hubspot: '/landing/integrations/hubspot.png',
  claude: '/landing/integrations/claude.png',
  'google-calendar': '/landing/integrations/google-calendar.png',
  figma: '/landing/integrations/figma.svg',
  x: '/landing/integrations/x.png',
}

export const DARK_ICON_PATHS = new Set([STATION_ICONS.github, STATION_ICONS.x])

export const LOOP_DELAY_MS = 2000

export type OutputDef = Omit<OutputState, 'progress' | 'status'>

export const OUTPUT_DEFS: OutputDef[] = [
  {
    id: 'dashboard',
    title: 'Pipeline Dashboard',
    type: 'dashboard',
    pairId: 'pair-1',
    agentId: 'duet',
  },
  {
    id: 'prd',
    title: 'Product Requirements',
    type: 'document',
    pairId: 'pair-1',
    agentId: 'duet',
  },
  {
    id: 'email',
    title: 'Email Draft',
    type: 'email',
    pairId: 'pair-2',
    agentId: 'duet',
  },
  {
    id: 'social',
    title: 'X Post',
    type: 'social',
    pairId: 'pair-2',
    agentId: 'duet',
  },
]

export const PAIR_1_IDS: [string, string] = ['dashboard', 'prd']
export const PAIR_2_IDS: [string, string] = ['email', 'social']

export function getOutputIdsForPair(pairId: PairId): [string, string] {
  return pairId === 'pair-1' ? PAIR_1_IDS : PAIR_2_IDS
}

export const TIMELINE_STEPS: TimelineStep[] = [
  // All 4 workstreams kick off near-simultaneously (slight staggers for visual interest)
  {
    type: 'work-start',
    workstreamId: 'ws-pipeline',
    stationId: 'github',
    delayMs: 0,
    feedMessage: 'Pipeline velocity increased 12% month over month',
    workDurationMs: 9500,
  },
  {
    type: 'work-start',
    workstreamId: 'ws-prd',
    stationId: 'claude',
    delayMs: 200,
  },
  {
    type: 'work-start',
    workstreamId: 'ws-email',
    stationId: 'gmail',
    delayMs: 200,
    feedMessage: 'Drafting the stakeholder update now',
  },
  {
    type: 'work-start',
    workstreamId: 'ws-social',
    stationId: 'figma',
    delayMs: 200,
  },

  // Human gives direction
  {
    type: 'session-event',
    delayMs: 1500,
    eventActor: 'David',
    eventActorKind: 'human',
    eventActorAvatar: '/landing/features/david.jpg',
    eventContent: 'Prioritize the pipeline deck and TAM analysis',
  },

  // Icon cycle: workstreams switch to second tools
  {
    type: 'work-start',
    workstreamId: 'ws-pipeline',
    stationId: 'hubspot',
    delayMs: 2000,
  },
  {
    type: 'work-start',
    workstreamId: 'ws-prd',
    stationId: 'notion',
    delayMs: 500,
    feedMessage: 'TAM analysis done — $4.2B, 34% YoY growth',
  },
  {
    type: 'work-start',
    workstreamId: 'ws-social',
    stationId: 'x',
    delayMs: 500,
    feedMessage: 'Launch brief complete — all set',
  },

  // Human gives direction
  {
    type: 'session-event',
    delayMs: 1500,
    eventActor: 'Walter',
    eventActorKind: 'human',
    eventActorAvatar: '/landing/features/walter.png',
    eventContent: 'Nice, keep the product analysis in this session',
  },

  // Pair-1 workstreams complete
  {
    type: 'work-complete',
    workstreamId: 'ws-pipeline',
    delayMs: 2500,
    feedMessage: 'Pipeline dashboard ready — 42 deals tracked',
  },
  {
    type: 'work-complete',
    workstreamId: 'ws-prd',
    delayMs: 500,
    feedMessage: 'PRD draft complete and attached',
  },

  // Swap to pair 2
  { type: 'swap-outputs', pairId: 'pair-2', delayMs: 800 },

  // Start pair-2 progress after swap so user sees it build from 0
  {
    type: 'work-start',
    workstreamId: 'ws-email',
    stationId: 'google-calendar',
    delayMs: 200,
    workDurationMs: 6000,
  },

  // Pair-2 workstreams complete
  {
    type: 'work-complete',
    workstreamId: 'ws-email',
    delayMs: 5000,
    feedMessage: 'Stakeholder update sent',
  },
  {
    type: 'work-complete',
    workstreamId: 'ws-social',
    delayMs: 500,
    feedMessage: 'Post scheduled for tomorrow 9am',
  },

  // Hold + reset
  { type: 'reset', delayMs: 2000 },
]
