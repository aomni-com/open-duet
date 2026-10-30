import type { AnchorMoveCandidatesReport, GatewayAnchor } from '@repo/contract'

export interface AnchorRegistry {
  /** One-for-one reconcile used by API pushes. */
  reconcile(anchors: readonly GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]>
  /** Coalesced reconcile used by the recurring sync path. */
  reconcileSync(anchors: readonly GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]>
  snapshot(): GatewayAnchor[]
}

interface DeferredResult {
  resolve(value: AnchorMoveCandidatesReport[]): void
  reject(error: unknown): void
}

interface SyncUnit {
  desired: GatewayAnchor[] | null
  waiters: DeferredResult[]
}

export function createAnchorRegistry(options: {
  reconcileMarkers: (anchors: GatewayAnchor[]) => Promise<AnchorMoveCandidatesReport[]>
}): AnchorRegistry {
  let anchors: GatewayAnchor[] = []
  let tail = Promise.resolve()
  let adjacentSync: SyncUnit | null = null

  function apply(next: GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]> {
    const result = options.reconcileMarkers(next).then(reports => {
      anchors = next
      return reports
    })
    return result
  }

  function append<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function reconcile(nextValue: readonly GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]> {
    adjacentSync = null
    const next = structuredClone(nextValue) as GatewayAnchor[]
    return append(() => apply(next))
  }

  function reconcileSync(
    nextValue: readonly GatewayAnchor[],
  ): Promise<AnchorMoveCandidatesReport[]> {
    const next = structuredClone(nextValue) as GatewayAnchor[]
    const result = new Promise<AnchorMoveCandidatesReport[]>((resolve, reject) => {
      if (adjacentSync !== null) {
        adjacentSync.desired = next
        adjacentSync.waiters.push({ resolve, reject })
        return
      }
      const unit: SyncUnit = { desired: next, waiters: [{ resolve, reject }] }
      adjacentSync = unit
      void append(async () => {
        while (unit.desired !== null) {
          const desired = unit.desired
          const waiters = unit.waiters
          unit.desired = null
          unit.waiters = []
          try {
            const reports = await apply(desired)
            waiters.forEach(waiter => waiter.resolve(reports))
          } catch (error) {
            waiters.forEach(waiter => waiter.reject(error))
          }
        }
        if (adjacentSync === unit) adjacentSync = null
      })
    })
    return result
  }

  return {
    reconcile,
    reconcileSync,
    snapshot() {
      return structuredClone(anchors)
    },
  }
}
