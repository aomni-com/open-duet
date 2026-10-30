'use client'

import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'

export function CodeBlock(props: ComponentProps<'pre'>) {
  const code = useRef<HTMLPreElement>(null)
  const hintId = useId()
  const [scrolls, setScrolls] = useState(false)
  const [status, setStatus] = useState<'idle' | 'copied' | 'unavailable'>('idle')
  useEffect(() => {
    const element = code.current
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
  }, [props.children])

  async function copy() {
    const value = code.current?.textContent
    if (value === undefined || value.length === 0) return
    try {
      await navigator.clipboard.writeText(value)
      setStatus('copied')
    } catch {
      setStatus('unavailable')
    }
    window.setTimeout(() => setStatus('idle'), 1_500)
  }

  return (
    <div className="code-block">
      <button className="copy-button" type="button" onClick={copy} aria-live="polite">
        {status === 'copied' ? 'Copied' : status === 'unavailable' ? 'Copy unavailable' : 'Copy'}
      </button>
      {scrolls ? (
        <p id={hintId} className="code-scroll-hint">
          Scroll horizontally to see the full line.
        </p>
      ) : null}
      <pre
        {...props}
        ref={code}
        tabIndex={scrolls ? 0 : undefined}
        aria-describedby={scrolls ? hintId : undefined}
      />
    </div>
  )
}
