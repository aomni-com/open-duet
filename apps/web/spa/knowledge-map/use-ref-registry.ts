'use client'

/* A stable ref callback per key.

   The map hands every node and every edge a callback that files its element in
   a Map for the animation loop to write to. Written inline — `ref={el => …}` —
   that closure is a new function on every render, so React detaches and
   reattaches every ref each time, and any memoised child sees a changed prop
   and re-renders anyway. Caching one callback per key makes the prop stable, so
   the memo above it can actually do its job.

   Callbacks are dropped when their element unmounts, so the cache tracks what
   is on screen rather than everything that has ever been on it. */
import { useCallback, useRef, type RefObject } from 'react'

export function useRefRegistry<T>(
  store: RefObject<Map<string, T>>,
): (key: string) => (el: T | null) => void {
  const cache = useRef(new Map<string, (el: T | null) => void>())

  return useCallback(
    (key: string) => {
      const existing = cache.current.get(key)
      if (existing) return existing
      const set = (el: T | null): void => {
        if (el) store.current.set(key, el)
        else {
          store.current.delete(key)
          cache.current.delete(key)
        }
      }
      cache.current.set(key, set)
      return set
    },
    [store],
  )
}
