'use client'

import { Browser, CircleNotch, Warning } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { browserOwnerKey, type DesktopOwnerActivity, type DesktopPhase } from '@repo/contract'

import type { WorkspaceRefusalCopyKey } from '../workspace-refusal'
import { fitDesktop, measureDesktopContainer, type DesktopSize } from './desktop-fit'

type DesktopFrameSource = (entryUrl: string) => string

const DesktopFrameSourceContext = createContext<DesktopFrameSource>(entryUrl => entryUrl)

/** Hermetic fixtures replace the credential-bearing VM URL with a static frame. */
export function DesktopFrameSourceProvider({
  source,
  children,
}: {
  source: DesktopFrameSource
  children: ReactNode
}) {
  return (
    <DesktopFrameSourceContext.Provider value={source}>
      {children}
    </DesktopFrameSourceContext.Provider>
  )
}

export function DesktopPane({
  phase,
  entryUrl,
  owners,
  screen,
  refusal,
}: {
  phase: DesktopPhase
  entryUrl: string | null
  owners: DesktopOwnerActivity[]
  screen: DesktopSize
  refusal?: WorkspaceRefusalCopyKey
}) {
  const t = useTranslations('duetApp.desktop')
  const frameSource = useContext(DesktopFrameSourceContext)
  const containerRef = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<DesktopSize>(screen)

  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const measure = () => {
      setContainer(measureDesktopContainer(element))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rect = fitDesktop(container, screen)
  const ready = refusal === undefined && phase === 'ready' && entryUrl !== null
  const railFitsInTopPadding = rect.y >= DRIVER_RAIL_HEIGHT

  return (
    <section
      aria-label={t('label')}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#10131a] shadow-inner"
    >
      {ready && !railFitsInTopPadding ? <DriverRail owners={owners} /> : null}
      <div ref={containerRef} className="relative min-h-[28rem] w-full flex-1 overflow-hidden">
        {ready && railFitsInTopPadding ? (
          <div
            className="absolute z-10"
            style={{
              left: rect.x,
              top: rect.y - DRIVER_RAIL_HEIGHT,
              width: rect.width,
              height: DRIVER_RAIL_HEIGHT,
            }}
          >
            <DriverRail owners={owners} />
          </div>
        ) : null}
        {refusal !== undefined ? (
          <div className="absolute inset-0 grid place-items-center p-8 text-center text-white">
            <div className="max-w-sm" role="alert">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
                <Warning aria-hidden size={26} weight="fill" />
              </div>
              <h2 className="mt-5 text-lg font-semibold tracking-tight">
                {t(`refusals.${refusal}.title`)}
              </h2>
              <p className="mt-2 text-sm leading-6 text-white/60">
                {t(`refusals.${refusal}.body`)}
              </p>
            </div>
          </div>
        ) : ready ? (
          <div
            className="absolute overflow-hidden bg-black shadow-2xl ring-1 ring-white/10"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          >
            <iframe
              title={t('frameTitle')}
              src={frameSource(entryUrl)}
              referrerPolicy="no-referrer"
              width={screen.width}
              height={screen.height}
              sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads"
              allow="clipboard-read; clipboard-write"
              allowFullScreen
              className="origin-top-left border-0 bg-black"
              style={{ transform: `scale(${rect.scale})` }}
            />
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center p-8 text-center text-white">
            <div className="max-w-sm">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/5">
                <CircleNotch aria-hidden className="animate-spin text-white/80" size={26} />
              </div>
              <h2 className="mt-5 text-lg font-semibold tracking-tight">{t('connectingTitle')}</h2>
              <p className="mt-2 text-sm leading-6 text-white/55">{t('connectingBody')}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

const DRIVER_RAIL_HEIGHT = 44

function DriverRail({ owners }: { owners: DesktopOwnerActivity[] }) {
  const t = useTranslations('duetApp.desktop')
  return (
    <div
      data-desktop-owner-rail
      aria-label={owners.length > 0 ? t('ownersLabel') : undefined}
      aria-hidden={owners.length === 0}
      className="flex h-11 items-center justify-end gap-2 border-b border-white/10 px-3"
    >
      {owners.map(owner => {
        const name =
          owner.owner.kind === 'root'
            ? 'Duet'
            : (owner.agentName ?? owner.agentSlug ?? owner.owner.agentId)
        return (
          <span
            key={browserOwnerKey(owner.owner)}
            aria-label={
              owner.focused ? t('focusedOwnerLabel', { name }) : t('ownerLabel', { name })
            }
            className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-1.5 text-xs font-medium shadow-lg ${owner.focused ? 'border-emerald-300/25 bg-emerald-950/85 text-emerald-100' : 'border-white/10 bg-black/55 text-white/65'}`}
          >
            <Browser aria-hidden className="shrink-0" size={12} weight="fill" />
            <span className="truncate">{name}</span>
          </span>
        )
      })}
    </div>
  )
}
