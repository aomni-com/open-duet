export interface DesktopScreen {
  width: 1440
  height: 900
}

export interface DesktopSession {
  entryUrl: string
  expiresAt: number
  phase: 'stopped' | 'starting' | 'ready'
  screen: DesktopScreen
}

export interface DesktopStatus {
  phase: DesktopSession['phase']
  viewers: number
  owners: Array<{
    owner: { kind: 'root' } | { kind: 'agent'; agentId: string }
    agentSlug?: string
    agentName?: string
    phase: 'active' | 'cooling' | 'idle'
    focused: boolean
    liveBatchCount: number
    batchTabCount: number
    discardedBatchTabCount: number
    lastActiveAt: number
  }>
}

export interface DesktopFocusResult {
  focused: boolean
}

export type DesktopFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
