'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

export function EmailFrame({ subject, children }: { subject: string; children: ReactNode }) {
  const [srcDoc] = useState(() => renderToStaticMarkup(<>{children}</>))
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(600)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    let paintFrame = 0
    const measure = () => {
      const body = iframe.contentDocument?.body
      if (!body) return
      setHeight(body.scrollHeight + 4)
      paintFrame = requestAnimationFrame(() => {
        const settledBody = iframe.contentDocument?.body
        if (!settledBody) return
        setHeight(settledBody.scrollHeight + 4)
        setReady(true)
      })
    }

    iframe.addEventListener('load', measure)
    if (iframe.contentDocument?.readyState === 'complete') measure()
    return () => {
      iframe.removeEventListener('load', measure)
      cancelAnimationFrame(paintFrame)
    }
  }, [srcDoc])

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
      <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Subject line
        </p>
        <p className="mt-1 text-sm font-medium">{subject}</p>
      </div>
      <iframe
        ref={iframeRef}
        title={subject}
        srcDoc={srcDoc}
        sandbox="allow-same-origin"
        data-playground-wait-for-frame
        data-playground-frame-ready={ready ? 'true' : 'false'}
        className="w-full overflow-hidden rounded-lg border border-border/60 bg-white"
        style={{ height }}
      />
    </div>
  )
}
