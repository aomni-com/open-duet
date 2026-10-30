'use client'

import { motion, useInView } from 'framer-motion'
import { useRef, type ComponentProps, type ComponentType, type PropsWithChildren } from 'react'

export function AnimateIn<P = object>({
  component = 'div',
  className,
  animateUp,
  startInView,
  amount = 0.2,
  once = true,
  initial = { opacity: 0 },
  animate = { opacity: 1 },
  transition,
  children,
  ...props
}: PropsWithChildren<
  {
    component?: 'div' | 'span' | ComponentType<PropsWithChildren<P>>
    className?: string

    // when set to true, will set initial and animate prop to be an up fade animation
    animateUp?: boolean

    // inView props
    // when set to true, the element will be hidden at first, and only shown when scrolled to view
    startInView?: boolean
    amount?: number
    once?: boolean

    // motion props
    initial?: ComponentProps<typeof motion.div>['initial']
    animate?: ComponentProps<typeof motion.div>['animate']
    transition?: ComponentProps<typeof motion.div>['transition']
  } & P
>) {
  const ref = useRef(null)
  const inView = useInView(ref, { amount, once })

  const Element =
    typeof component === 'string'
      ? component === 'div'
        ? motion.div
        : motion.span
      : (motion(component) as ComponentType<PropsWithChildren<object>>)

  const initialProp = animateUp ? { opacity: 0, y: 24 } : initial
  const animateProp = animateUp ? { opacity: 1, y: 0 } : animate
  return (
    <Element
      ref={ref}
      className={className}
      initial={initialProp}
      animate={startInView ? (inView ? animateProp : false) : animateProp}
      transition={transition}
      {...props}
    >
      {children}
    </Element>
  )
}
