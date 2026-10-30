import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DUET_AGENT,
  getOutputIdsForPair,
  LOOP_DELAY_MS,
  OUTPUT_DEFS,
  PAIR_1_IDS,
  STATION_ICONS,
  TIMELINE_STEPS,
  WORKSTREAMS,
} from './agent-animation-data'
import type {
  AgentState,
  OutputState,
  PairId,
  SessionEvent,
  TimelineStep,
  WorkstreamState,
} from './types'

type UseAgentTimelineOptions = {
  prefersReducedMotion: boolean
  layout: 'desktop' | 'mobile'
  isActive?: boolean
}

type UseAgentTimelineResult = {
  duetAgent: AgentState
  workstreams: WorkstreamState[]
  sessionEvents: SessionEvent[]
  outputs: OutputState[]
  visibleOutputIds: [string, string]
}

function buildInitialDuetAgent(): AgentState {
  return {
    id: DUET_AGENT.id,
    name: DUET_AGENT.name,
    color: DUET_AGENT.color,
    orbColors: DUET_AGENT.orbColors,
    activity: 'idle',
    expression: 'neutral',
    visible: true,
    workingIcon: null,
    completed: false,
  }
}

function buildInitialWorkstreams(): WorkstreamState[] {
  return WORKSTREAMS.map(w => ({
    ...w,
    status: 'idle' as const,
    activeIcon: null,
  }))
}

function buildInitialOutputs(): OutputState[] {
  return OUTPUT_DEFS.map(d => ({
    ...d,
    progress: 0,
    status: (d.pairId === 'pair-1' ? 'building' : 'idle') as OutputState['status'],
  }))
}

export function useAgentTimeline({
  prefersReducedMotion,
  isActive = true,
}: UseAgentTimelineOptions): UseAgentTimelineResult {
  const [duetAgent, setDuetAgent] = useState<AgentState>(buildInitialDuetAgent)
  const [workstreams, setWorkstreams] = useState<WorkstreamState[]>(buildInitialWorkstreams)
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([])
  const [outputs, setOutputs] = useState<OutputState[]>(buildInitialOutputs)
  const [visibleOutputIds, setVisibleOutputIds] = useState<[string, string]>(PAIR_1_IDS)

  const visibleOutputIdsRef = useRef<[string, string]>(PAIR_1_IDS)

  const timeoutsRef = useRef<number[]>([])
  const eventCounterRef = useRef(0)
  const completedCountRef = useRef(0)
  const progressIntervalsRef = useRef<Record<PairId, number | null>>({
    'pair-1': null,
    'pair-2': null,
  })
  const pairsStartedRef = useRef<Record<PairId, boolean>>({
    'pair-1': false,
    'pair-2': false,
  })

  const getEffectiveDuration = useCallback(
    (ms: number) => (prefersReducedMotion ? Math.min(ms, 120) : ms),
    [prefersReducedMotion],
  )

  const clearAllTimers = useCallback(() => {
    timeoutsRef.current.forEach(id => window.clearTimeout(id))
    timeoutsRef.current = []
    for (const key of ['pair-1', 'pair-2'] as PairId[]) {
      const intervalId = progressIntervalsRef.current[key]
      if (intervalId !== null) {
        window.clearInterval(intervalId)
        progressIntervalsRef.current[key] = null
      }
    }
  }, [])

  const wait = useCallback((ms: number) => {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      const id = window.setTimeout(() => {
        timeoutsRef.current = timeoutsRef.current.filter(t => t !== id)
        resolve()
      }, ms)
      timeoutsRef.current.push(id)
    })
  }, [])

  const startPairProgress = useCallback((pairId: PairId, durationMs: number) => {
    if (pairsStartedRef.current[pairId]) return
    pairsStartedRef.current[pairId] = true

    const pairOutputIds = getOutputIdsForPair(pairId)

    setOutputs(prev =>
      prev.map(o => (pairOutputIds.includes(o.id) ? { ...o, status: 'building' as const } : o)),
    )

    const tickInterval = 50
    const totalTicks = durationMs / tickInterval
    let tick = 0

    const intervalId = window.setInterval(() => {
      tick++
      const progress = Math.min(tick / totalTicks, 0.95)
      setOutputs(prev => prev.map(o => (pairOutputIds.includes(o.id) ? { ...o, progress } : o)))
      if (tick >= totalTicks) {
        window.clearInterval(intervalId)
        if (progressIntervalsRef.current[pairId] === intervalId) {
          progressIntervalsRef.current[pairId] = null
        }
      }
    }, tickInterval)
    progressIntervalsRef.current[pairId] = intervalId
  }, [])

  const updateSessionEvent = useCallback((id: string, updates: Partial<SessionEvent>) => {
    setSessionEvents(prev =>
      prev.map(event => (event.id === id ? { ...event, ...updates } : event)),
    )
  }, [])

  const addSessionEvent = useCallback(
    (
      actorName: string,
      actorKind: 'agent' | 'human',
      content: string,
      actorColor?: string,
      actorAvatar?: string,
    ) => {
      eventCounterRef.current += 1
      const id = `session-event-${eventCounterRef.current}`
      const timestamp = Date.now()

      if (actorKind === 'agent') {
        setSessionEvents(prev => [
          ...prev,
          {
            id,
            actorName,
            actorKind,
            actorColor,
            actorAvatar,
            content: '',
            timestamp,
            isPending: true,
          },
        ])
        const tid = window.setTimeout(() => {
          updateSessionEvent(id, { isPending: false, content })
          timeoutsRef.current = timeoutsRef.current.filter(t => t !== tid)
        }, 600)
        timeoutsRef.current.push(tid)
      } else {
        setSessionEvents(prev => [
          ...prev,
          {
            id,
            actorName,
            actorKind,
            actorColor,
            actorAvatar,
            content,
            timestamp,
          },
        ])
      }
    },
    [updateSessionEvent],
  )

  const resetState = useCallback(() => {
    setDuetAgent(buildInitialDuetAgent())
    setWorkstreams(buildInitialWorkstreams())
    setSessionEvents([])
    setOutputs(buildInitialOutputs())
    setVisibleOutputIds(PAIR_1_IDS)
    visibleOutputIdsRef.current = PAIR_1_IDS
    pairsStartedRef.current = { 'pair-1': false, 'pair-2': false }
    completedCountRef.current = 0
    for (const key of ['pair-1', 'pair-2'] as PairId[]) {
      const intervalId = progressIntervalsRef.current[key]
      if (intervalId !== null) {
        window.clearInterval(intervalId)
        progressIntervalsRef.current[key] = null
      }
    }
  }, [])

  // Store callbacks in refs to avoid re-firing the effect when they change identity
  const getEffectiveDurationRef = useRef(getEffectiveDuration)
  getEffectiveDurationRef.current = getEffectiveDuration
  const waitRef = useRef(wait)
  waitRef.current = wait
  const clearAllTimersRef = useRef(clearAllTimers)
  clearAllTimersRef.current = clearAllTimers
  const resetStateRef = useRef(resetState)
  resetStateRef.current = resetState
  const addSessionEventRef = useRef(addSessionEvent)
  addSessionEventRef.current = addSessionEvent
  const startPairProgressRef = useRef(startPairProgress)
  startPairProgressRef.current = startPairProgress

  useEffect(() => {
    if (!isActive) {
      clearAllTimersRef.current()
      resetStateRef.current()
      return
    }

    let cancelled = false

    const processStep = async (step: TimelineStep) => {
      const delay = getEffectiveDurationRef.current(step.delayMs)
      if (delay > 0) {
        await waitRef.current(delay)
      }
      if (cancelled) return

      switch (step.type) {
        case 'work-start': {
          if (!step.workstreamId || !step.stationId) break
          const icon = STATION_ICONS[step.stationId] ?? null

          setWorkstreams(prev =>
            prev.map(w =>
              w.id === step.workstreamId
                ? {
                    ...w,
                    status: 'working' as const,
                    activeIcon: icon,
                  }
                : w,
            ),
          )

          setDuetAgent(prev => ({
            ...prev,
            activity: 'working' as const,
            expression: 'focused' as const,
            completed: false,
          }))

          if (step.feedMessage) {
            addSessionEventRef.current('Duet', 'agent', step.feedMessage, DUET_AGENT.color)
          }

          const ws = WORKSTREAMS.find(w => w.id === step.workstreamId)
          if (ws && step.workDurationMs) {
            startPairProgressRef.current(ws.pairId, step.workDurationMs)
          }
          break
        }

        case 'work-complete': {
          if (!step.workstreamId) break

          completedCountRef.current += 1

          setWorkstreams(prev =>
            prev.map(w =>
              w.id === step.workstreamId
                ? { ...w, status: 'completed' as const, activeIcon: null }
                : w,
            ),
          )

          if (completedCountRef.current === WORKSTREAMS.length) {
            setDuetAgent(prev => ({
              ...prev,
              activity: 'idle' as const,
              expression: 'happy' as const,
              completed: false,
            }))
          }

          if (step.feedMessage) {
            addSessionEventRef.current('Duet', 'agent', step.feedMessage, DUET_AGENT.color)
          }
          break
        }

        case 'session-event': {
          if (step.eventContent && step.eventActor) {
            addSessionEventRef.current(
              step.eventActor,
              step.eventActorKind ?? 'human',
              step.eventContent,
              undefined,
              step.eventActorAvatar,
            )
          }
          break
        }

        case 'swap-outputs': {
          const targetPairId = step.pairId ?? 'pair-2'

          // Complete current pair outputs
          const currentPairOutputIds = visibleOutputIdsRef.current
          setOutputs(prev =>
            prev.map(o =>
              currentPairOutputIds.includes(o.id)
                ? { ...o, status: 'completed' as const, progress: 1 }
                : o,
            ),
          )

          // Staggered swap: top slot first, then bottom after a visible pause
          const newIds = getOutputIdsForPair(targetPairId)
          await waitRef.current(400)
          if (cancelled) return
          visibleOutputIdsRef.current = [newIds[0], visibleOutputIdsRef.current[1]]
          setVisibleOutputIds([newIds[0], visibleOutputIdsRef.current[1]])

          await waitRef.current(800)
          if (cancelled) return
          visibleOutputIdsRef.current = [newIds[0], newIds[1]]
          setVisibleOutputIds([newIds[0], newIds[1]])
          break
        }

        case 'reset': {
          // Complete all outputs
          setOutputs(prev =>
            prev.map(o => ({
              ...o,
              status: 'completed' as const,
              progress: 1,
            })),
          )
          break
        }
      }
    }

    const runTimeline = async () => {
      resetStateRef.current()

      for (const step of TIMELINE_STEPS) {
        if (cancelled) return
        await processStep(step)
      }
    }

    const runLoop = async () => {
      while (!cancelled) {
        await runTimeline()
        if (cancelled) break
        await waitRef.current(getEffectiveDurationRef.current(LOOP_DELAY_MS))
      }
    }

    runLoop()

    return () => {
      cancelled = true
      clearAllTimersRef.current()
    }
    // isActive is the only meaningful trigger — callbacks are accessed via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  return { duetAgent, workstreams, sessionEvents, outputs, visibleOutputIds }
}
