'use client'

import { useEffect, useState } from 'react'

/**
 * Hook for tracking active heading during scroll.
 * Uses Intersection Observer for performance.
 */
export function useActiveHeading(headingIds: string[]) {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        })
      },
      {
        rootMargin: '-20% 0px -80% 0px',
        threshold: 0,
      },
    )

    headingIds.forEach(id => {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    })

    return () => observer.disconnect()
  }, [headingIds])

  return activeId
}
