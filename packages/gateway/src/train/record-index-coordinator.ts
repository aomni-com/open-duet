import { basename, dirname, extname, resolve } from 'node:path'

import type { DriveFileEvent } from '@repo/contract'

import type { TrainScope } from './agent-scope'
import {
  markTrainRecordRepairNow,
  rebuildTrainRecordIndex,
  reconcileTrainRecordIndex,
  type OnTrainRecordSkipped,
  resetTrainRecordIndexNow,
  TrainRecordIndexError,
  trainScopeFingerprint,
} from './record-index'

export interface TrainRecordIndexCoordinator {
  syncScopes(scopes: readonly TrainScope[]): Promise<void>
  onFileEvent(event: DriveFileEvent): void
  onFileEventLoss(): void
  recoverFileEventLoss(): Promise<void>
  assertScopeReady(scope: TrainScope): void
  settled(): Promise<void>
}

export function createTrainRecordIndexCoordinator(options: {
  driveDir: string
  stateDir: string
  onError?: (error: unknown) => void
  onRecordSkipped?: OnTrainRecordSkipped
}): TrainRecordIndexCoordinator {
  let scopes = new Map<string, TrainScope>()
  const readyFingerprints = new Map<string, string>()
  const dirty = new Map<string, Map<string, { target: string; generation?: string }>>()
  let tail = Promise.resolve()
  let initialized = false
  let fileEventLossGeneration = 0
  let recoveredFileEventLossGeneration = 0

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = tail.then(work)
    tail = next.catch(error => options.onError?.(error))
    return next
  }

  // Planning opens the index synchronously; a failure there reports through
  // the same channel as a failed rebuild and rejects instead of throwing, so
  // a caller can treat both the same way.
  function syncScopes(nextScopes: readonly TrainScope[]): Promise<void> {
    try {
      return planScopeSync(nextScopes)
    } catch (error) {
      options.onError?.(error)
      return Promise.reject(error)
    }
  }

  function planScopeSync(nextScopes: readonly TrainScope[]): Promise<void> {
    const previousScopes = scopes
    scopes = new Map(nextScopes.map(scope => [scope.key, scope]))
    for (const key of readyFingerprints.keys()) {
      if (!scopes.has(key)) readyFingerprints.delete(key)
    }
    for (const key of dirty.keys()) {
      if (!scopes.has(key)) dirty.delete(key)
    }
    const rebuilds = nextScopes.flatMap(scope => {
      const fingerprint = trainScopeFingerprint(scope)
      if (readyFingerprints.get(scope.key) === fingerprint && !dirty.has(scope.key)) return []
      const workId = crypto.randomUUID()
      markDirty(scope.key, workId, '__scope__')
      const generation = markTrainRecordRepairNow(scope, options.stateDir, '__scope__')
      setDirtyGeneration(scope.key, workId, generation)
      return [
        {
          scope,
          fingerprint,
          clearRepairs: !initialized || !previousScopes.has(scope.key),
        },
      ]
    })
    initialized = true
    return enqueue(async () => {
      for (const rebuild of rebuilds) {
        const repairedWorkIds = [...(dirty.get(rebuild.scope.key)?.keys() ?? [])]
        const repairGenerations = repairedWorkIds.flatMap(workId => {
          const generation = dirty.get(rebuild.scope.key)?.get(workId)?.generation
          return generation === undefined ? [] : [generation]
        })
        await rebuildTrainRecordIndex(
          rebuild.scope,
          options.stateDir,
          rebuild.clearRepairs ? undefined : repairGenerations,
          options.onRecordSkipped,
        )
        if (scopes.get(rebuild.scope.key) === rebuild.scope) {
          readyFingerprints.set(rebuild.scope.key, rebuild.fingerprint)
        }
        markWorkIdsClean(rebuild.scope.key, repairedWorkIds)
      }
    })
  }

  function onFileEvent(event: DriveFileEvent): void {
    if (event.kind === 'restore') {
      const current = [...scopes.values()]
      readyFingerprints.clear()
      for (const scope of current) {
        markDirty(scope.key, '__restore__', '__restore__')
        try {
          resetTrainRecordIndexNow(scope, options.stateDir)
          const generation = markTrainRecordRepairNow(scope, options.stateDir, '__restore__')
          setDirtyGeneration(scope.key, '__restore__', generation)
        } catch (error) {
          options.onError?.(error)
        }
      }
      void enqueue(async () => {
        for (const scope of current) {
          const repairedWorkIds = [...(dirty.get(scope.key)?.keys() ?? [])]
          const repairGenerations = repairedWorkIds.flatMap(workId => {
            const generation = dirty.get(scope.key)?.get(workId)?.generation
            return generation === undefined ? [] : [generation]
          })
          await rebuildTrainRecordIndex(
            scope,
            options.stateDir,
            repairGenerations,
            options.onRecordSkipped,
          )
          if (scopes.get(scope.key) === scope) {
            readyFingerprints.set(scope.key, trainScopeFingerprint(scope))
          }
          markWorkIdsClean(scope.key, repairedWorkIds)
        }
      })
      return
    }
    if (
      event.kind === 'read' ||
      event.kind === 'changed-summary' ||
      event.kind === 'viewed-summary'
    ) {
      return
    }
    if ('entryKind' in event && event.entryKind === 'folder') return
    const paths = event.kind === 'rename' ? [event.fromPath, event.path] : [event.path]
    for (const path of new Set(paths)) {
      const target = recordTarget(path)
      if (target === null) continue
      const workId = crypto.randomUUID()
      markDirty(target.scope.key, workId, target.slug)
      let generation: string
      try {
        generation = markTrainRecordRepairNow(target.scope, options.stateDir, target.slug)
      } catch (error) {
        options.onError?.(error)
        continue
      }
      setDirtyGeneration(target.scope.key, workId, generation)
      void enqueue(async () => {
        const repairedWorkIds = [...(dirty.get(target.scope.key)?.entries() ?? [])]
          .filter(([, item]) => item.target === target.slug)
          .map(([id]) => id)
        const repairGenerations = repairedWorkIds.flatMap(id => {
          const repair = dirty.get(target.scope.key)?.get(id)?.generation
          return repair === undefined ? [] : [repair]
        })
        await reconcileTrainRecordIndex(
          target.scope,
          options.stateDir,
          target.slug,
          repairGenerations,
          options.onRecordSkipped,
        )
        markWorkIdsClean(target.scope.key, repairedWorkIds)
      })
    }
  }

  function markDirty(scope: string, workId: string, target: string): void {
    const pending = dirty.get(scope) ?? new Map()
    pending.set(workId, { target })
    dirty.set(scope, pending)
  }

  function setDirtyGeneration(scope: string, workId: string, generation: string): void {
    const pending = dirty.get(scope)
    const item = pending?.get(workId)
    if (item !== undefined) pending!.set(workId, { ...item, generation })
  }

  function markWorkIdsClean(scope: string, workIds: readonly string[]): void {
    const pending = dirty.get(scope)
    for (const workId of workIds) pending?.delete(workId)
    if (pending?.size === 0) dirty.delete(scope)
  }

  function onFileEventLoss(): void {
    fileEventLossGeneration += 1
    for (const scope of scopes.values()) {
      const workId = `__event_loss__:${fileEventLossGeneration}:${scope.key}`
      markDirty(scope.key, workId, '__event_loss__')
      try {
        const generation = markTrainRecordRepairNow(scope, options.stateDir, '__event_loss__')
        setDirtyGeneration(scope.key, workId, generation)
      } catch (error) {
        options.onError?.(error)
      }
    }
  }

  function recoverFileEventLoss(): Promise<void> {
    const recoveryGeneration = fileEventLossGeneration
    if (recoveryGeneration === recoveredFileEventLossGeneration) return tail
    const current = [...scopes.values()]
    return enqueue(async () => {
      if (recoveryGeneration <= recoveredFileEventLossGeneration) return
      for (const scope of current) {
        const repairedWorkIds = [...(dirty.get(scope.key)?.keys() ?? [])]
        const generations = repairedWorkIds
          .flatMap(workId => {
            const item = dirty.get(scope.key)?.get(workId)
            return item === undefined ? [] : [item]
          })
          .flatMap(item => (item.generation === undefined ? [] : [item.generation]))
        await rebuildTrainRecordIndex(scope, options.stateDir, generations)
        markWorkIdsClean(scope.key, repairedWorkIds)
        if (scopes.get(scope.key) === scope) {
          readyFingerprints.set(scope.key, trainScopeFingerprint(scope))
        }
      }
      recoveredFileEventLossGeneration = recoveryGeneration
    })
  }

  function recordTarget(path: string): { scope: TrainScope; slug: string } | null {
    if (extname(path) !== '.md') return null
    const absolute = resolve(options.driveDir, ...path.split('/'))
    for (const scope of scopes.values()) {
      if (dirname(absolute) === resolve(scope.memoriesDir)) {
        return { scope, slug: basename(absolute, '.md') }
      }
    }
    return null
  }

  return {
    syncScopes,
    onFileEvent,
    onFileEventLoss,
    recoverFileEventLoss,
    assertScopeReady(scope): void {
      if (dirty.has(scope.key)) throw new TrainRecordIndexError('index_unavailable')
    },
    settled: () => tail,
  }
}
