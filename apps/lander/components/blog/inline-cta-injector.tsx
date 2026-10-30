'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Injects a CTA element after the Nth h2 heading within the article content.
 * Uses a DOM ref to find h2 elements and insert a marker div, then portals the CTA into it.
 */
export function InlineCTAInjector({
  articleRef,
  afterHeading = 3,
  children,
}: {
  articleRef: React.RefObject<HTMLElement | null>
  afterHeading?: number
  children: React.ReactNode
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const article = articleRef.current
    if (!article) return

    const headings = article.querySelectorAll('h2')
    const targetIndex = Math.min(afterHeading - 1, headings.length - 1)
    if (targetIndex < 0) return

    const targetHeading = headings[targetIndex]
    if (!targetHeading) return

    const existing = article.querySelector('[data-inline-cta]')
    if (existing) {
      setContainer(existing as HTMLElement)
      return
    }

    const marker = document.createElement('div')
    marker.setAttribute('data-inline-cta', 'true')
    targetHeading.parentNode?.insertBefore(marker, targetHeading)
    setContainer(marker)

    return () => {
      marker.remove()
    }
  }, [articleRef, afterHeading])

  if (!container) return null
  return createPortal(children, container)
}
