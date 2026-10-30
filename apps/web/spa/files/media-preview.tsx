'use client'

import {
  ArrowSquareOutIcon,
  FileImageIcon,
  DownloadSimpleIcon,
  FileAudioIcon,
  FileVideoIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PauseIcon,
  PlayIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { WorkspaceEmptyState } from '../drive/workspace-page'

// Media presentation for an open document: an image stage with zoom, a
// video stage that fades in when playable, and a card-style audio player.
// All three take a plain download URL, so they stay provider-agnostic.

const ZOOM_MIN = 25
const ZOOM_MAX = 200
const ZOOM_STEP = 25

/** An image on a calm stage: zoom controls above, fade-in when decoded. */
export function ImagePreview({
  url,
  sourceKey,
  name,
}: {
  url: string
  sourceKey?: string
  name: string
}) {
  const t = useTranslations('duetApp.filesSurface.viewer')
  const surfaceT = useTranslations('duetApp.filesSurface')
  const reduceMotion = useReducedMotion()
  const [zoom, setZoom] = useState(100)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [displayed, setDisplayed] = useState({ url, sourceKey })

  useEffect(() => {
    if (url === displayed.url) return
    let active = true
    const candidate = new Image()
    candidate.onload = () => {
      if (!active) return
      setLoaded(true)
      setFailed(false)
      setDisplayed({ url, sourceKey })
    }
    candidate.src = url
    return () => {
      active = false
      candidate.onload = null
    }
  }, [displayed.url, sourceKey, url])

  if (failed) {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center p-6">
        <WorkspaceEmptyState
          tone="muted"
          icon={<FileImageIcon weight="duotone" />}
          title={surfaceT('previewFailed')}
          body={t('imageUnavailableBody')}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border/60 bg-muted/20 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:size-8"
          aria-label={t('zoomOut')}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoom(value => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
        >
          <MagnifyingGlassMinusIcon className="size-4" />
        </Button>
        <span className="min-w-[4ch] text-center text-xs tabular-nums text-muted-foreground">
          {zoom}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:size-8"
          aria-label={t('zoomIn')}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom(value => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
        >
          <MagnifyingGlassPlusIcon className="size-4" />
        </Button>
      </div>
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto bg-muted/10 p-4">
        <img
          key={displayed.sourceKey}
          src={displayed.url}
          alt={name}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'max-h-full max-w-full rounded-lg object-contain shadow-sm',
            'transition-[opacity,transform] duration-300',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          style={{ transform: `scale(${zoom / 100})` }}
        />
        <AnimatePresence>
          {!loaded ? (
            <motion.div
              role="status"
              aria-label={surfaceT('opening')}
              className="absolute inset-4 grid place-items-center rounded-xl border border-border/40 bg-background/45 backdrop-blur-[2px]"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <SpinnerGapIcon
                  aria-hidden
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                {surfaceT('opening')}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** A video on a dark stage that fades in once the browser can play it. */
export function VideoPreview({
  url,
  sourceKey,
  name,
  downloadUrl,
}: {
  url: string
  sourceKey?: string
  name: string
  downloadUrl: string
}) {
  const t = useTranslations('duetApp.filesSurface.viewer')
  const surfaceT = useTranslations('duetApp.filesSurface')
  const reduceMotion = useReducedMotion()
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [displayed, setDisplayed] = useState({ url, sourceKey })
  useEffect(() => {
    if (url === displayed.url) return
    const candidate = document.createElement('video')
    let accepted = false
    const accept = () => {
      if (accepted) return
      accepted = true
      setReady(true)
      setFailed(false)
      setDisplayed({ url, sourceKey })
    }
    candidate.addEventListener('loadeddata', accept, { once: true })
    candidate.addEventListener('canplay', accept, { once: true })
    candidate.preload = 'metadata'
    candidate.src = url
    candidate.load()
    return () => {
      candidate.removeEventListener('loadeddata', accept)
      candidate.removeEventListener('canplay', accept)
      candidate.removeAttribute('src')
      candidate.load()
    }
  }, [displayed.url, sourceKey, url])
  if (failed) {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center p-6">
        <WorkspaceEmptyState
          tone="muted"
          icon={<FileVideoIcon weight="duotone" />}
          title={t('videoUnavailable')}
          body={t('videoUnavailableBody')}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ArrowSquareOutIcon className="mr-2 size-4" />
                  {t('openInNewTab')}
                </a>
              </Button>
              <Button asChild size="sm">
                <a href={downloadUrl} download={name}>
                  <DownloadSimpleIcon className="mr-2 size-4" />
                  {t('download')}
                </a>
              </Button>
            </div>
          }
        />
      </div>
    )
  }
  return (
    <div className="relative grid h-full min-h-0 place-items-center bg-muted/20 p-3 sm:p-5 dark:bg-muted/10">
      <video
        key={displayed.sourceKey}
        src={displayed.url}
        controls
        playsInline
        preload="metadata"
        onLoadedData={() => setReady(true)}
        onCanPlay={() => setReady(true)}
        onError={() => setFailed(true)}
        className={cn(
          'max-h-full max-w-full rounded-lg object-contain transition-opacity duration-300',
          ready ? 'opacity-100' : 'opacity-0',
        )}
      />
      <AnimatePresence>
        {!ready ? (
          <motion.div
            role="status"
            aria-label={surfaceT('opening')}
            className="absolute inset-4 grid place-items-center rounded-xl border border-white/10 bg-background/50 backdrop-blur-sm"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <SpinnerGapIcon
                aria-hidden
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              {surfaceT('opening')}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/** A card audio player: format tile, round play control, custom seekbar. */
export function AudioPreview({
  url,
  sourceKey,
  name,
}: {
  url: string
  sourceKey?: string
  name: string
}) {
  const t = useTranslations('duetApp.filesSurface.viewer')
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const [time, setTime] = useState({ current: 0, duration: 0 })

  useEffect(() => {
    setPlaying(false)
    setFailed(false)
    setTime({ current: 0, duration: 0 })
  }, [url])

  const syncTime = () => {
    const element = audio.current
    if (element === null) return
    setTime({
      current: element.currentTime,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
    })
  }

  const toggle = () => {
    const element = audio.current
    if (element === null) return
    if (element.paused) void element.play()
    else element.pause()
  }
  const seek = (value: number) => {
    const element = audio.current
    if (element === null || time.duration === 0) return
    element.currentTime = value
    setTime(current => ({ ...current, current: value }))
  }
  const progress = time.duration === 0 ? 0 : (time.current / time.duration) * 100

  return (
    <div className="grid h-full min-h-[24rem] place-items-center p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-6 shadow-xs sm:p-8">
        <div className="mb-6 flex flex-col items-center gap-3">
          <span
            aria-hidden
            className="grid size-20 place-items-center rounded-2xl bg-brand/10 ring-1 ring-inset ring-brand/20"
          >
            <FileAudioIcon weight="duotone" className="size-10 text-brand" />
          </span>
          <p className="max-w-full truncate text-base font-semibold">{name}</p>
        </div>
        {failed ? (
          <p className="text-center text-sm text-muted-foreground">{t('audioUnavailable')}</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggle}
                aria-label={playing ? t('pause') : t('play')}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground shadow-sm transition-[background-color,transform] hover:scale-[1.03] hover:bg-brand/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:hover:scale-100"
              >
                {playing ? (
                  <PauseIcon weight="fill" className="size-4" />
                ) : (
                  <PlayIcon weight="fill" className="ml-0.5 size-4" />
                )}
              </button>
              <div className="relative flex h-11 flex-1 items-center rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                <div
                  aria-hidden
                  className="absolute inset-x-0 h-2 rounded-full bg-muted-foreground/40 dark:bg-muted-foreground/50"
                >
                  <div
                    className="h-full rounded-full bg-brand transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span
                  aria-hidden
                  className="pointer-events-none absolute size-4 -translate-x-1/2 rounded-full border-2 border-card bg-brand shadow-sm"
                  style={{ left: `${progress}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={time.duration || 0}
                  step={0.1}
                  value={Math.min(time.current, time.duration || 0)}
                  disabled={time.duration === 0}
                  aria-label={t('seek')}
                  onChange={event => seek(event.currentTarget.valueAsNumber)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                />
              </div>
            </div>
            <div className="mt-3 flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{formatAudioTime(time.current)}</span>
              <span>{formatAudioTime(time.duration)}</span>
            </div>
          </>
        )}
        <audio
          key={sourceKey}
          ref={audio}
          src={url}
          preload="metadata"
          onLoadedMetadata={syncTime}
          onDurationChange={syncTime}
          onTimeUpdate={syncTime}
          onSeeking={syncTime}
          onPlay={() => {
            setPlaying(true)
            syncTime()
          }}
          onPause={() => {
            setPlaying(false)
            syncTime()
          }}
          onEnded={() => {
            setPlaying(false)
            syncTime()
          }}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  )
}

function formatAudioTime(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
