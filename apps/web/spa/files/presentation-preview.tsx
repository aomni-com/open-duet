'use client'

import {
  CaretLeftIcon,
  CaretRightIcon,
  FilePptIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { PPTXViewer as PptxViewerInstance } from 'pptxviewjs'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { OfficeFallback } from './office-preview'

export function PresentationPreview({
  bytes,
  fileName,
  downloadUrl,
}: {
  bytes: Uint8Array
  fileName: string
  downloadUrl: string
}) {
  const t = useTranslations('duetApp.filesSurface')
  const viewerT = useTranslations('duetApp.filesSurface.viewer')
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<PptxViewerInstance | null>(null)
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'failed'
    index: number
    count: number
  }>({ status: 'loading', index: 0, count: 0 })
  const [zoom, setZoom] = useState(100)
  useEffect(() => {
    let active = true
    setZoom(100)
    const load = async () => {
      const { PPTXViewer } = await import('pptxviewjs')
      if (canvas.current === null) return
      const instance = new PPTXViewer({
        canvas: canvas.current,
        slideSizeMode: 'fit',
        backgroundColor: '#ffffff',
      })
      await instance.loadFile(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
      if (!active) return instance.destroy()
      viewer.current = instance
      await instance.render()
      if (active) setState({ status: 'ready', index: 0, count: instance.getSlideCount() })
    }
    void load().catch(() => active && setState(current => ({ ...current, status: 'failed' })))
    return () => {
      active = false
      viewer.current?.destroy()
      viewer.current = null
    }
  }, [bytes])
  if (state.status === 'failed') {
    return <OfficeFallback fileName={fileName} downloadUrl={downloadUrl} />
  }
  const go = (index: number) => {
    if (index < 0 || index >= state.count || viewer.current === null) return
    void viewer.current.goToSlide(index).then(() => setState(current => ({ ...current, index })))
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-muted/20">
      {state.status === 'loading' ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80">
          <FilePptIcon
            weight="duotone"
            className="size-8 animate-pulse text-muted-foreground"
            aria-hidden
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        <div
          className={cn(
            'flex h-full min-w-full items-center',
            zoom === 100 ? 'justify-center' : 'justify-start',
          )}
        >
          <canvas
            ref={canvas}
            width={1280}
            height={720}
            className="h-auto max-h-full w-auto max-w-full shrink-0 rounded shadow-sm transition-[opacity,transform] duration-200"
            style={{
              opacity: state.status === 'ready' ? 1 : 0,
              transform: zoom === 100 ? undefined : `scale(${zoom / 100})`,
              transformOrigin: 'left center',
            }}
          />
        </div>
      </div>
      {state.status === 'ready' ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border/60 bg-background/70 px-2 py-1.5">
          {state.count > 1 ? (
            <>
              <Button
                variant="outline"
                size="icon"
                className="size-11 bg-background/55 disabled:bg-transparent sm:size-9"
                aria-label={t('previousSlide')}
                disabled={state.index === 0}
                onClick={() => go(state.index - 1)}
              >
                <CaretLeftIcon />
              </Button>
              <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
                {state.index + 1} / {state.count}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-11 bg-background/55 disabled:bg-transparent sm:size-9"
                aria-label={t('nextSlide')}
                disabled={state.index === state.count - 1}
                onClick={() => go(state.index + 1)}
              >
                <CaretRightIcon />
              </Button>
              <span aria-hidden className="mx-0.5 h-5 w-px bg-border/70" />
            </>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            className="size-11 bg-background/55 disabled:bg-transparent sm:size-9"
            aria-label={viewerT('zoomOut')}
            disabled={zoom <= 100}
            onClick={() => setZoom(value => Math.max(100, value - 25))}
          >
            <MagnifyingGlassMinusIcon />
          </Button>
          <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
            {zoom}%
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-11 bg-background/55 disabled:bg-transparent sm:size-9"
            aria-label={viewerT('zoomIn')}
            disabled={zoom >= 200}
            onClick={() => setZoom(value => Math.min(200, value + 25))}
          >
            <MagnifyingGlassPlusIcon />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
