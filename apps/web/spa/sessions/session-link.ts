'use client'

import { useCallback } from 'react'
import { useNavigate } from 'react-router'

/**
 * Where a link inside a rendered session message should go.
 *
 * `in-app`   — a same-origin link that the SPA router should handle as an
 *              in-place navigation. `to` is the path (+ search + hash) only,
 *              never the origin, so React Router treats it as an app route.
 * `external` — anything else (a different origin, a protocol-relative host,
 *              `mailto:`, or an unparseable string). `href` is the original
 *              string, opened verbatim in a new browsing context.
 */
export type SessionLinkTarget = { kind: 'in-app'; to: string } | { kind: 'external'; href: string }

/**
 * The single owner of the same-origin-vs-external decision for links agents (or
 * users) write into a message. `Markdown` in `@repo/ui` calls `preventDefault()`
 * on every anchor once a handler is supplied, so a handler that only knew how to
 * route `/w/...` would silently make every external link inert — this branch
 * exists to keep those links alive.
 *
 * `origin` is the current page origin (`window.location.origin`). Links are
 * resolved against it, so a bare path (`/w/x/agents/y`), a same-origin absolute
 * URL, and a same-origin protocol-relative URL all resolve in-app; every other
 * origin, `mailto:`, and unparseable input fall through to `external`.
 */
export function sessionLinkTarget(href: string, origin: string): SessionLinkTarget {
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return { kind: 'external', href }
  }
  if (url.origin === origin) {
    return { kind: 'in-app', to: url.pathname + url.search + url.hash }
  }
  return { kind: 'external', href }
}

/**
 * The wiring both message-markdown call sites share: resolve the link, then
 * either navigate in-SPA or open a new browsing context. One owner, so neither
 * renderer re-implements the branch.
 */
export function useSessionLinkClick(): (href: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (href: string) => {
      const target = sessionLinkTarget(href, window.location.origin)
      if (target.kind === 'in-app') {
        navigate(target.to)
        return
      }
      window.open(target.href, '_blank', 'noopener')
    },
    [navigate],
  )
}
