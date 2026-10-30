'use client'

import { CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { createContext, useContext, useState, type ReactNode } from 'react'

import { appIsInstalling, type App } from '@repo/contract'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { appDisplayStatus } from '../status/entity-status'
import { appDisplayName } from './app-icon'

// Every app — private or public, running or broken — opens inside the product,
// on the card of the agent whose folder encloses it (`agents-map-url` builds
// that address). The public URL is a sharing artifact, never the way a member
// reaches their own app.
//
// The frame source: a redirect that mints a short-lived access grant and leaves
// the edge holding the session cookie, so a private app renders for anyone who
// can already read the drive.
export function appFrameSource(workspaceSlug: string, appSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}/launch`
}

type AppFrameSource = (workspaceSlug: string, appSlug: string) => string

const AppFrameSourceContext = createContext<AppFrameSource>(appFrameSource)

/** Hermetic fixtures substitute a static page for the live workspace frame. */
export function AppFrameSourceProvider({
  source,
  children,
}: {
  source: AppFrameSource
  children: ReactNode
}) {
  return <AppFrameSourceContext.Provider value={source}>{children}</AppFrameSourceContext.Provider>
}

export function useAppFrameSource(): AppFrameSource {
  return useContext(AppFrameSourceContext)
}

export function AppFrameBody({ app, workspaceSlug }: { app: App; workspaceSlug: string }) {
  const frameSource = useAppFrameSource()
  const status = appDisplayStatus(app)

  if (status !== 'reconciled') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl">
          <AppUnavailable app={app} status={status} />
          {/* `AppUnavailable` renders nothing for a broken anchor, so this is
              what a reader gets told instead of a blank frame. It says what
              happened and stops there: repairing the link meant typing the
              folder's new Drive path, which is a sentence about anchors — the
              product's own word for something a reader has never had to know.
              The app's menu offers the one honest answer, which is to delete
              it; putting the folder back is the agent's job. */}
          {status === 'broken' ? <BrokenAnchorNotice /> : null}
        </div>
      </div>
    )
  }

  return <AppFrameCanvas name={appDisplayName(app)} src={frameSource(workspaceSlug, app.slug)} />
}

/**
 * The frame, and what stands in it until the app has painted.
 *
 * The wait is not a detail of a slow app. The frame's source is a redirect that
 * mints an access grant before the app's own boot even starts, so every opening
 * spends that time on a document that does not exist yet — and an iframe with
 * nothing in it is *transparent*, which is why this is a matter of layers:
 *
 * - the placeholder, underneath, holding the drive's own surface;
 * - the frame over it, carrying no colour of its own until it has loaded.
 *
 * So the gap is the product's, in whichever theme the reader is in, and the app
 * takes the surface over the moment it paints its own background. The frame
 * used to be nailed to `bg-white`, which is the whole of what a dark drive saw
 * while an app opened.
 *
 * The white canvas is not gone, though — it arrives with the app. A document
 * that sets no background of its own is transparent all the way down, and a
 * page written for a browser tab expects the white one a tab would have given
 * it; its black default text over this product's dark surface would be
 * unreadable. So a loaded app gets a tab's canvas, and only a loaded one.
 */
function AppFrameCanvas({ name, src }: { name: string; src: string }) {
  /* The source that has painted, not a bare boolean: the pane keeps one frame
     and swaps apps through it, and a flag would hand the next app the previous
     one's ready state — its first paint shown as the new app's. */
  const [painted, setPainted] = useState<string | null>(null)
  const ready = painted === src

  return (
    <div data-app-frame className="relative min-h-0 w-full flex-1 bg-background">
      {ready ? null : (
        <div className="absolute inset-0">
          <AppFramePlaceholder name={name} />
        </div>
      )}
      {/* The app is another origin's document: sandboxed so a workspace app
          cannot navigate the Duet tab it is running inside. External OAuth
          pages get a separate, unsandboxed tab because providers refuse to
          render in frames and may not function under inherited restrictions. */}
      <iframe
        title={name}
        src={src}
        sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
        onLoad={() => setPainted(src)}
        className={cn('absolute inset-0 size-full border-0', ready && 'bg-white')}
      />
    </div>
  )
}

/* Authored rather than random, so the silhouette cannot flicker between
   openings. Margins are used instead of fractional widths so every row keeps
   the same left edge and right gutter as the frame changes size. */
const ROW_TAILS = '4 32 1 45 21 7 38 15'.split(' ').map(percent => `${percent}%`)

/**
 * The shape of an app, before the app.
 *
 * An app is somebody else's document and this surface has no idea what is in
 * it, so the silhouette claims only a page hierarchy. The product owns the app
 * title bar above this frame; a second title bar would read as another
 * destination loading inside the first one.
 */
type AppFramePlaceholderProps = { name: string; announce?: true } | { announce: false }

export function AppFramePlaceholder(props: AppFramePlaceholderProps) {
  const announce = props.announce !== false
  const t = useTranslations('duetApp.appsSurface')
  return (
    <div
      role={announce ? 'status' : undefined}
      aria-busy={announce ? 'true' : undefined}
      aria-label={props.announce === false ? undefined : t('openingApp', { name: props.name })}
      aria-hidden={announce ? undefined : true}
      data-app-frame-placeholder
      className="size-full overflow-hidden bg-background"
    >
      <div aria-hidden className="flex size-full min-h-0 flex-col gap-4 p-4 sm:p-6">
        {/* Whatever the page is about, said once at the top of it. */}
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-6 w-64 max-w-[70%]" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
        {/* A row of the small things, then the one big thing under them —
              the shape a page keeps whether it turns out to be a dashboard, a
              form, or a list. */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="hidden h-20 rounded-xl sm:block" />
        </div>
        {/* The divider preserves one continuous page; a bordered container
              here would look like a nested frame and disappear on load. */}
        <div className="flex min-h-32 flex-1 flex-col overflow-hidden border-t border-border/50 pt-4">
          <Skeleton className="h-3 w-24 shrink-0" />
          <div className="mt-4 flex min-h-0 flex-1 flex-col justify-between gap-3 overflow-hidden">
            {ROW_TAILS.map(tail => (
              <div key={tail} className="flex shrink-0 items-center gap-3">
                <Skeleton className="size-6 shrink-0 rounded-md" />
                <Skeleton className="h-3 flex-1 rounded-sm" style={{ marginRight: tail }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function BrokenAnchorNotice() {
  const t = useTranslations('duetApp.appsSurface')
  return (
    <div className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive">
      <WarningCircle className="mt-0.5 shrink-0" size={20} />
      <div>
        <p className="font-semibold">{t('brokenAnchor')}</p>
        <p className="mt-1 text-sm">{t('brokenAnchorBody')}</p>
      </div>
    </div>
  )
}

function AppUnavailable({
  app,
  status,
}: {
  app: App
  status: ReturnType<typeof appDisplayStatus>
}) {
  const t = useTranslations('duetApp.appsSurface')
  if (status === 'reconciling') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm font-medium text-amber-700 dark:text-amber-300">
        <CircleNotch className="animate-spin" size={19} />
        {t('startingBody')}
      </div>
    )
  }
  if (status === 'disabled') {
    /* Two ways to be switched off, and only one of them has a switch. A share
       replica is off because the recipient turned it off, and turning it back
       on is a thing they can do. A subscription-owned app is off because its
       files have not arrived yet — so telling THIS reader to turn it back on
       sends them hunting for a control that does not exist. */
    return (
      <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
        {t(appIsInstalling(app) ? 'installingBody' : 'disabledBody')}
      </div>
    )
  }
  if (status === 'broken') return null
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive"
    >
      <WarningCircle className="mt-0.5 shrink-0" size={20} />
      <div>
        <p className="font-semibold">{t('reconcileFailed')}</p>
        <p className="mt-1 text-sm">{t('reconcileFailedBody')}</p>
        {app.reconciliationError ? (
          <p className="mt-2 text-xs">
            {t('diagnosticReason')}: <code className="font-mono">{app.reconciliationError}</code>
          </p>
        ) : null}
      </div>
    </div>
  )
}
