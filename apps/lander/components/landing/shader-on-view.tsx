'use client'

import { useInView } from 'framer-motion'
import React from 'react'

import { useHasWebgl } from '@/components/landing/atoms'

type Options = NonNullable<Parameters<typeof useInView>[1]>

type ShaderOnViewProps<TProps extends object> = {
  shaderComponent: React.ComponentType<TProps>
  shaderProps: TProps
  margin?: Options['margin']
  once?: boolean
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>

const DetectionMargin: Options['margin'] = '-400px 0px 400px 0px'

/**
 * Mounts a shader background only once it is near the viewport AND the client
 * can actually run it. The capability check is not an optimisation: a shader
 * library that finds no GL context reports it by throwing, and these
 * backgrounds sit high in the tree, so the alternative to not mounting is the
 * whole page unmounting for every reader without a GPU — scrapers, agents'
 * headless browsers, hardened browsers, a machine whose GPU process died.
 */
function ShaderOnViewInner<TProps extends object>({
  shaderComponent: ShaderComponent,
  shaderProps,
  once = false,
  className,
  ...rest
}: ShaderOnViewProps<TProps>) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isVisible = useInView(containerRef, {
    margin: DetectionMargin,
    once,
  })
  const hasWebgl = useHasWebgl()

  return (
    <div ref={containerRef} className={className} {...rest}>
      {isVisible && hasWebgl ? (
        <div style={{ width: '100%', height: '100%' }}>
          <ShaderComponent {...shaderProps} />
        </div>
      ) : null}
    </div>
  )
}

export const ShaderOnView = React.memo(ShaderOnViewInner) as typeof ShaderOnViewInner
