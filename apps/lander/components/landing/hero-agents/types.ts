export type AgentExpression = 'neutral' | 'focused' | 'happy'

export type AgentActivity = 'idle' | 'working'

export type AgentDef = {
  id: string
  name: string
  color: string
  orbColors: { c1: string; c2: string; c3: string }
}

export type OutputType = 'dashboard' | 'document' | 'email' | 'social'

export type PairId = 'pair-1' | 'pair-2'

export type WorkstreamDef = {
  id: string
  label: string
  color: string
  outputId: string
  pairId: PairId
  statusMessages: string[]
}

export type WorkstreamState = WorkstreamDef & {
  status: 'idle' | 'working' | 'completed'
  activeIcon: string | null
}

export type TimelineStepType =
  | 'spawn'
  | 'work-start'
  | 'work-complete'
  | 'session-event'
  | 'feed'
  | 'swap-outputs'
  | 'reset'

export type TimelineStep = {
  type: TimelineStepType
  agentId?: string
  workstreamId?: string
  stationId?: string
  delayMs: number
  feedMessage?: string
  eventActor?: string
  eventActorKind?: 'agent' | 'human'
  eventContent?: string
  workDurationMs?: number
  artifactId?: string
  pairId?: PairId
  eventActorAvatar?: string
}

export type AgentState = {
  id: string
  name: string
  color: string
  orbColors: { c1: string; c2: string; c3: string }
  activity: AgentActivity
  expression: AgentExpression
  visible: boolean
  workingIcon: string | null
  completed: boolean
}

export type FeedEntry = {
  id: string
  message: string
  timestamp: number
}

export type SessionEvent = {
  id: string
  actorName: string
  actorKind: 'agent' | 'human'
  actorColor?: string
  actorAvatar?: string
  content: string
  timestamp: number
  isPending?: boolean
}

export type OutputState = {
  id: string
  title: string
  type: OutputType
  progress: number
  status: 'idle' | 'building' | 'completed'
  pairId: PairId
  agentId: string
}

export type HeroAgentVizProps = {
  layout?: 'desktop' | 'mobile'
  className?: string
  sessionEventsLabel?: string
}
