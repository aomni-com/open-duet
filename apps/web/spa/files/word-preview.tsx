'use client'

import { FileDocIcon } from '@phosphor-icons/react'
import { renderAsync } from 'docx-preview'
import DOMPurify from 'dompurify'
import { useEffect, useRef, useState } from 'react'

import { OfficeFallback } from './office-preview'

export function WordPreview({
  bytes,
  fileName,
  downloadUrl,
}: {
  bytes: Uint8Array
  fileName: string
  downloadUrl: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const hasAcceptedContent = useRef(false)
  const [hasContent, setHasContent] = useState(false)
  const [status, setStatus] = useState<'rendering' | 'ready' | 'failed'>('rendering')
  useEffect(() => {
    let active = true
    const render = async () => {
      const candidate = document.createElement('div')
      await renderAsync(bytes, candidate, undefined, {
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true,
      })
      if (!active || container.current === null) return
      container.current.innerHTML = DOMPurify.sanitize(candidate.innerHTML, {
        ADD_ATTR: ['class', 'style'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick'],
      })
      hasAcceptedContent.current = true
      setHasContent(true)
      setStatus('ready')
    }
    setStatus('rendering')
    void render().catch(() => {
      if (!active) return
      setStatus(hasAcceptedContent.current ? 'ready' : 'failed')
    })
    return () => {
      active = false
    }
  }, [bytes])
  if (status === 'failed') {
    return <OfficeFallback fileName={fileName} downloadUrl={downloadUrl} />
  }
  return (
    <div className="relative h-full min-h-0 bg-muted/45 dark:bg-muted/20">
      {status === 'rendering' && !hasContent ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80">
          <FileDocIcon
            weight="duotone"
            className="size-8 animate-pulse text-muted-foreground"
            aria-hidden
          />
        </div>
      ) : null}
      <div
        ref={container}
        className="h-full overflow-auto overscroll-contain p-3 transition-opacity duration-200 sm:p-5 [&_.docx-wrapper]:mx-auto [&_.docx-wrapper]:!w-full [&_.docx-wrapper]:min-w-full [&_.docx-wrapper]:!items-start [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0 [&_section.docx]:!mx-auto [&_section.docx]:!mb-0 [&_section.docx]:!p-[clamp(1.5rem,6vw,6rem)] [&_section.docx]:box-border [&_section.docx]:max-w-full [&_section.docx]:shadow-md [&_section.docx]:ring-1 [&_section.docx]:ring-border/50 dark:[&_section.docx]:shadow-black/40"
        style={{ opacity: hasContent ? 1 : 0 }}
      />
    </div>
  )
}
