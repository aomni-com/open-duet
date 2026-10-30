'use client'

import { useEffect, useId, useRef, useState } from 'react'

/** Display wrapping never changes the command text a reader copies. */
export function InstallCodeBlock({ block }: { block: string }) {
  const pre = useRef<HTMLPreElement>(null)
  const hintId = useId()
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const element = pre.current
    if (!element) return
    let disposed = false
    const measure = () => {
      if (!disposed) setScrolls(element.scrollWidth > element.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    void document.fonts.ready.then(measure)
    measure()
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [block])
  const lines = block.split('\n')
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
      {scrolls ? (
        <p id={hintId} className="px-4 pt-3 text-xs text-muted-foreground sm:px-6">
          Scroll horizontally to see the full line.
        </p>
      ) : null}
      <pre
        ref={pre}
        tabIndex={scrolls ? 0 : undefined}
        aria-label="Code example"
        aria-describedby={scrolls ? hintId : undefined}
        className="overflow-x-auto whitespace-pre-wrap p-4 text-sm leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] sm:p-6"
      >
        <code>
          {lines.map((line, index) => (
            <span
              key={index}
              className={
                /^# \d+\./.test(line)
                  ? 'font-semibold'
                  : line.startsWith('#')
                    ? 'text-muted-foreground'
                    : undefined
              }
            >
              {line}
              {index < lines.length - 1 ? '\n' : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
