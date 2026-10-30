'use client'

/* ============================================================================
   The one moving part of the header order.

   `header-order.ts` is pure so it can be tested against a world that shifts
   underneath it — apps appearing, apps deleted, a stored value written by an
   older build. This owns the part that cannot be pure: the reader's arrangement,
   read once per agent and written back on every change.

   It lives here rather than inside the surface because the order has to outlive
   the mount. Flying out to the ring and back into the same agent unmounts the
   card, and an arrangement held in the card's own state would go with it.
   ========================================================================= */
import { useCallback, useMemo, useRef, useState } from 'react'

import {
  orderedItems,
  readOrder,
  reorder,
  writeOrder,
  type HeaderInput,
  type HeaderItem,
} from './header-order'

export type HeaderRow = {
  items: HeaderItem[]
  /**
   * `moved` lands where `onto` is.
   *
   * The only way the order changes. Pointer and keyboard both arrive here,
   * because `@dnd-kit`'s keyboard sensor speaks the same events its pointer
   * sensor does — which is the reason for taking the dependency rather than
   * hand-rolling a second gesture that would have drifted from the first.
   */
  drop: (moved: string, onto: string) => void
}

/**
 * The row for this agent, and the one way it is rearranged.
 *
 * `agentId` keys the storage, so switching agents switches arrangement. The
 * saved order is held in state rather than read on every render because a drag
 * has to be on screen before the next paint: storage is the slow copy, written
 * after the fact and never read during one.
 */
export function useHeaderRow(
  agentId: string,
  { appIds }: HeaderInput,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): HeaderRow {
  const store = useMemo(() => {
    if (storage !== undefined) return storage
    /* A browser can refuse to hand this over at all — private modes do, and the
       access itself throws rather than returning null. Nothing here is worth a
       broken card, and the row works perfectly well unarranged. */
    try {
      return typeof window === 'undefined' ? undefined : window.localStorage
    } catch {
      return undefined
    }
  }, [storage])

  const [saved, setSaved] = useState<string[] | null>(() => readOrder(store, agentId))
  /* Re-read when the agent changes rather than only on mount: the reader can fly
     from one agent to another without this unmounting, and arriving back at one
     they arranged earlier has to show that arrangement. Set during render rather
     than in an effect so the first paint of the new agent is already right —
     React re-runs this render with the new state before committing anything. */
  const lastAgent = useRef(agentId)
  if (lastAgent.current !== agentId) {
    lastAgent.current = agentId
    setSaved(readOrder(store, agentId))
  }

  /* Keyed on the ids themselves rather than the array, which the caller rebuilds
     on every render of a query result. */
  const appKeys = appIds.join(' ')
  const items = useMemo(
    () => orderedItems({ appIds: appKeys === '' ? [] : appKeys.split(' '), saved }),
    [appKeys, saved],
  )

  const commit = useCallback(
    (keys: string[]) => {
      setSaved(keys)
      writeOrder(store, agentId, keys)
    },
    [agentId, store],
  )

  const drop = useCallback(
    (moved: string, onto: string) => {
      commit(
        reorder(
          items.map(item => item.key),
          moved,
          onto,
        ),
      )
    },
    [commit, items],
  )

  return { items, drop }
}
