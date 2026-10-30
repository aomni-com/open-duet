'use client'

import { createContext } from 'react'

// Portals escape an inert DOM subtree, but retain its React context. Suspending
// their scope removes focus traps and overlays without discarding form state.
export const OverlaySuspendedContext = createContext(false)
