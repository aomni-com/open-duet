import { useEffect, useState } from 'react'

export function usePrefersMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches)
    }
    updatePreference()

    if ('addEventListener' in mediaQuery) {
      mediaQuery.addEventListener('change', updatePreference)
      return () => mediaQuery.removeEventListener('change', updatePreference)
    }

    if ('addListener' in mediaQuery) {
      const legacyMediaQuery = mediaQuery as MediaQueryList & {
        addListener: (listener: () => void) => void
        removeListener: (listener: () => void) => void
      }
      legacyMediaQuery.addListener(updatePreference)
      return () => legacyMediaQuery.removeListener(updatePreference)
    }

    return undefined
  }, [])

  return { prefersReducedMotion }
}
