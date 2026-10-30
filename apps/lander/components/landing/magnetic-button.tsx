'use client'

import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import { type ComponentProps, useRef } from 'react'

import { Link } from '@/i18n/navigation'

type MagneticButtonProps = ComponentProps<typeof Link> & {
  /**
   * Maximum cursor-follow distance in px. 0 disables the magnetic effect.
   */
  strength?: number
}

/**
 * A Link that subtly follows the cursor when it gets near — the touch that
 * makes buttons on Linear / Family feel tactile instead of static.
 *
 * The motion lives on a wrapper `motion.div`; the `<Link>` stays a normal
 * Next link so routing and accessibility behave as expected.
 */
export function MagneticButton({
  children,
  strength = 16,
  className,
  ...linkProps
}: MagneticButtonProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const springX = useSpring(x, { stiffness: 180, damping: 14, mass: 0.4 })
  const springY = useSpring(y, { stiffness: 180, damping: 14, mass: 0.4 })

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current
    // `MotionConfig reducedMotion` doesn't gate useSpring-driven style transforms,
    // so the cursor-follow drift is disabled explicitly for reduced-motion users.
    if (!el || strength === 0 || reduce) return
    const rect = el.getBoundingClientRect()
    const relX = event.clientX - rect.left - rect.width / 2
    const relY = event.clientY - rect.top - rect.height / 2
    const half = Math.max(rect.width, rect.height) / 2
    const clampedX = Math.max(-1, Math.min(1, relX / half)) * strength
    const clampedY = Math.max(-1, Math.min(1, relY / half)) * strength
    x.set(clampedX)
    y.set(clampedY)
  }

  const handleLeave = () => {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ x: springX, y: springY }}
      className="inline-flex"
    >
      <Link className={className} {...linkProps}>
        {children}
      </Link>
    </motion.div>
  )
}
