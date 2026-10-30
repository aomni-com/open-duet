import { motion } from 'framer-motion'
import { useEffect, useRef, useState, type PropsWithChildren } from 'react'

import { type PropsWithClassName } from '../../types'

type Props = PropsWithChildren & PropsWithClassName

export function AnimateHeight({ children, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | 'auto'>('auto')

  useEffect(() => {
    if (containerRef.current) {
      const resizeObserver = new ResizeObserver(entries => {
        // We only have one entry for the container
        const entry = entries[0]

        if (!entry) {
          return
        }

        const observedHeight = entry.contentRect.height
        setHeight(observedHeight || 'auto')
      })

      resizeObserver.observe(containerRef.current)

      return () => {
        resizeObserver.disconnect()
      }
    }
  }, [])

  return (
    <motion.div
      className={className}
      style={{ height }}
      animate={{ height }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
    >
      <div ref={containerRef}>{children}</div>
    </motion.div>
  )
}
