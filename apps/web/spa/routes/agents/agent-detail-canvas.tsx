'use client'

import { AppWindow, Brain, Cube, DotsThree, Lightning, Sparkle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import type { App, SessionSummary } from '@repo/contract'
import { Markdown } from '@repo/ui/components/common/markdown'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../../agents/agent-avatar'
import { AgentOnboardingCta } from '../../drive/agent-onboarding-cta'
import type { AgentOnboardingTarget } from '../../drive/agent-onboarding-projection'
import {
  AGENT_MENU_ACTION_KEYS,
  AGENT_MENU_ITEMS,
  type AgentMenuShape,
  type AgentRosterMenuAction,
} from '../../drive/agent-roster-types'
import { driveFolderUrl, driveRoutes } from '../../drive/drive-routes'
import { browserPathFromAnchorPath } from '../../files/lib/paths'
import {
  AGENT_STATUS_LABEL_KEYS,
  AGENT_STATUS_PILL_KEYS,
  statusClasses,
  type AgentDisplayStatus,
} from '../../status/entity-status'
import { workSessionUrl } from '../../team-space/work-destination'
import { ChatMarks, chatMarkState } from '../agents-map/chat-marks'
import { trainPath } from '../train/train-routes'

/**
 * The read-only agent detail canvas (D4): what an agent *is* and what it owns.
 * Pure presentation — every field is already resolved by the route, which owns
 * the queries and profile cache reuse.
 * Authoring stays in the drive and the `manage-agents` skill; the shared actions
 * hook owns the management menu's mutations outside this presentational canvas.
 */
export type AgentDetailCanvasProps = {
  workspaceSlug: string
  /**
   * Which agent this is, as an identity rather than as a set of fields.
   *
   * `root` is the drive root — Duet itself. It has no `agents` row, so it has
   * no slug to print beside its name and no folder to link to below the drive's
   * own; its Train and session links carry the root scope instead of a slug.
   * Everything else on the page — skills, `AGENTS.md`, apps, sessions — is the
   * same shape for both, which is the point: the default agent gets the same
   * page, not a page of its own.
   *
   * Deliberately not folded into `menu`: which actions you may take is a
   * different question from which agent you are looking at, and the two only
   * happen to line up today.
   */
  kind: 'root' | 'registered'
  name: string
  slug: string
  anchorPath: string
  icon?: string
  updatedAt: number
  status: AgentDisplayStatus
  locked: boolean
  onboardingTarget?: AgentOnboardingTarget
  trainSurface: 'enabled' | 'disabled'
  // The rendered `AGENTS.md`; `undefined` when the file is missing or unreadable —
  // a normal state that degrades to a readable empty note, never an error (D10).
  agentsMarkdown: string | undefined
  skills: readonly string[]
  hasMoreSkills?: boolean
  loadingMoreSkills?: boolean
  moreSkillsFailed?: boolean
  onShowAllSkills?: () => void
  apps: readonly App[]
  appsLoading?: boolean
  appsInitialError?: boolean
  hasMoreApps?: boolean
  loadingMoreApps?: boolean
  moreAppsFailed?: boolean
  onLoadMoreApps?: () => void
  onRetryApps?: () => void
  sessions: readonly Pick<
    SessionSummary,
    'id' | 'bucket' | 'unread' | 'title' | 'createdBySessionId'
  >[]
  hasMoreSessions: boolean
  sessionsLoading?: boolean
  sessionsInitialError?: boolean
  loadingMoreSessions?: boolean
  moreSessionsFailed?: boolean
  onShowAllSessions?: () => void
  onRetrySessions?: () => void
  renderAppIcon: (app: App) => ReactNode
  onNavigate?: () => void
  // The ⋯ menu shape (D21) and its handler, owned by the route. `replica` hides
  // rename/delete; `agent` shows the full set; `default` is Duet's — rename and
  // Open in Drive, since there is no folder to delete and nothing to share.
  // Absent `onMenuAction` renders the trigger inert (the playground's read-only
  // fixture).
  menu: AgentMenuShape
  onMenuAction?: (action: AgentRosterMenuAction) => void
}

export function AgentDetailCanvas({
  workspaceSlug,
  kind,
  name,
  slug,
  anchorPath,
  icon,
  updatedAt,
  status,
  locked,
  onboardingTarget,
  trainSurface,
  agentsMarkdown,
  skills,
  hasMoreSkills = false,
  loadingMoreSkills = false,
  moreSkillsFailed = false,
  onShowAllSkills,
  apps,
  appsLoading = false,
  appsInitialError = false,
  hasMoreApps = false,
  loadingMoreApps = false,
  moreAppsFailed = false,
  onLoadMoreApps,
  onRetryApps,
  sessions,
  hasMoreSessions,
  sessionsLoading = false,
  sessionsInitialError = false,
  loadingMoreSessions = false,
  moreSessionsFailed = false,
  onShowAllSessions,
  onRetrySessions,
  renderAppIcon,
  onNavigate,
  menu,
  onMenuAction,
}: AgentDetailCanvasProps) {
  const t = useTranslations('duetApp.agentDetail')
  const isRoot = kind === 'root'
  const trainScope = isRoot
    ? ({ kind: 'root' } as const)
    : ({ kind: 'agent', agentSlug: slug } as const)
  const pillKey = AGENT_STATUS_PILL_KEYS[status]
  return (
    <div className="block h-full min-w-0 overflow-y-auto bg-background">
      <div className="mx-auto max-w-5xl p-4 pb-24 sm:p-6 lg:p-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <AgentAvatar
              avatarKey={slug}
              duet={isRoot}
              profile={{ anchorPath, icon, updatedAt }}
              workspaceSlug={workspaceSlug}
              className="size-12 ring-1 ring-border/70"
            />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-2xl font-semibold tracking-tight">{name}</h2>
                <span
                  role="img"
                  aria-label={t(AGENT_STATUS_LABEL_KEYS[status])}
                  className={cn(
                    'size-2 shrink-0 rounded-full bg-current',
                    statusClasses(status).tint,
                  )}
                />
                {pillKey ? (
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      statusClasses(status).pill,
                    )}
                  >
                    {t(pillKey)}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {/* Duet has no slug to print and no folder of its own — it IS
                    the drive — so it names the root rather than echoing an
                    empty path. */}
                {isRoot ? null : <>{slug} · </>}
                <Link
                  to={
                    isRoot
                      ? driveRoutes.files(workspaceSlug)
                      : driveFolderUrl(workspaceSlug, browserPathFromAnchorPath(anchorPath))
                  }
                  onClick={onNavigate}
                  className="rounded-sm underline decoration-muted-foreground/40 underline-offset-2 outline-none hover:text-foreground hover:decoration-current focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {isRoot ? t('driveRoot') : anchorPath}
                </Link>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {trainSurface === 'enabled' ? (
              <Link
                to={trainPath(workspaceSlug, trainScope)}
                onClick={onNavigate}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/60 px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Brain aria-hidden size={16} weight="duotone" />
                {t('train')}
              </Link>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('actions')}
                  className="grid size-9 place-items-center rounded-lg border border-border/60 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <DotsThree aria-hidden size={18} weight="bold" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                {AGENT_MENU_ITEMS[menu].map(action => (
                  <DropdownMenuItem
                    key={action}
                    className={cn('text-sm', action === 'delete' && 'text-destructive')}
                    onSelect={() => onMenuAction?.(action)}
                  >
                    {t(AGENT_MENU_ACTION_KEYS[action])}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {locked ? (
          <div className="mt-6">
            <AgentOnboardingCta
              workspaceSlug={workspaceSlug}
              agentSlug={slug}
              target={onboardingTarget}
              onNavigate={onNavigate}
            />
          </div>
        ) : (
          <>
            {/* Skills deliberately holds two of three grid columns: a
                handful of chips stretched across the full content width reads
                as an unfinished stub. */}
            <div className="mt-6 grid items-start gap-4 lg:grid-cols-3">
              <DetailCard
                title={t('skills')}
                icon={<Sparkle size={16} />}
                className="lg:col-span-2"
              >
                {skills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5" aria-label={t('skills')}>
                    {skills.map(skill => (
                      <span
                        key={skill}
                        className="rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('noSkills')}</p>
                )}
                {hasMoreSkills && onShowAllSkills ? (
                  <button
                    type="button"
                    disabled={loadingMoreSkills}
                    onClick={onShowAllSkills}
                    className="mt-3 flex min-h-9 w-full items-center justify-center rounded-lg text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                  >
                    {loadingMoreSkills
                      ? t('loadingMore')
                      : moreSkillsFailed
                        ? t('retryMore')
                        : t('loadMore')}
                  </button>
                ) : null}
              </DetailCard>
            </div>

            <DetailCard title={t('readme')} icon={<Cube size={16} />} className="mt-4">
              {agentsMarkdown === undefined || agentsMarkdown.trim().length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('readmeEmpty')}</p>
              ) : (
                <Markdown className="text-sm">{agentsMarkdown}</Markdown>
              )}
            </DetailCard>

            <DetailCard title={t('apps')} icon={<AppWindow size={16} />} className="mt-4">
              {appsLoading ? (
                <p className="text-sm text-muted-foreground">{t('loadingMore')}</p>
              ) : appsInitialError ? (
                <div className="space-y-3">
                  <p className="text-sm text-destructive">{t('loadErrorBody')}</p>
                  {onRetryApps ? (
                    <button
                      type="button"
                      onClick={onRetryApps}
                      className="flex min-h-9 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('retry')}
                    </button>
                  ) : null}
                </div>
              ) : apps.length > 0 ? (
                <div aria-label={t('apps')} className="flex flex-wrap gap-2">
                  {apps.map(app => (
                    <Link
                      key={app.id}
                      to={`/w/${workspaceSlug}/apps/${app.slug}`}
                      onClick={onNavigate}
                      className="flex w-20 shrink-0 flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-card px-1.5 pb-1.5 pt-2.5 text-center text-muted-foreground outline-none transition-[color,background-color,border-color,box-shadow] duration-200 hover:border-border hover:bg-muted/45 hover:text-foreground hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="grid size-9 shrink-0 place-items-center">
                        {renderAppIcon(app)}
                      </span>
                      <span className="line-clamp-2 w-full break-words text-[10px] font-semibold leading-tight text-foreground">
                        {app.name ?? app.slug}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noApps')}</p>
              )}
              {(hasMoreApps || moreAppsFailed) && onLoadMoreApps ? (
                <button
                  type="button"
                  disabled={loadingMoreApps}
                  onClick={onLoadMoreApps}
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground shadow-xs outline-none transition-[color,background-color,border-color,box-shadow] hover:bg-muted/60 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                >
                  {loadingMoreApps
                    ? t('loadingMore')
                    : moreAppsFailed
                      ? t('retryMore')
                      : t('loadMore')}
                </button>
              ) : null}
            </DetailCard>

            <DetailCard title={t('sessions')} icon={<Lightning size={16} />} className="mt-4">
              {sessionsInitialError ? (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p role="alert">{t('sessionsLoadError')}</p>
                  {onRetrySessions === undefined ? null : (
                    <button
                      type="button"
                      onClick={onRetrySessions}
                      className="min-h-9 rounded-lg px-3 text-xs font-medium text-brand hover:bg-muted/60"
                    >
                      {t('retry')}
                    </button>
                  )}
                </div>
              ) : sessionsLoading && sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('sessionsLoading')}</p>
              ) : sessions.length > 0 || hasMoreSessions || moreSessionsFailed ? (
                <div role="group" aria-label={t('sessions')} className="space-y-0.5">
                  {sessions.map(session => (
                    <Link
                      key={session.id}
                      to={workSessionUrl(workspaceSlug, slug, session.id)}
                      onClick={onNavigate}
                      className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-[color,background-color] duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1 truncate leading-5">{session.title}</span>
                      {/* The marks every session list draws, trailing, so this
                          list and Work's say "running" and "needs you" alike. */}
                      <ChatMarks
                        unread={session.unread}
                        {...chatMarkState(session.bucket)}
                        label={t('unread')}
                      />
                    </Link>
                  ))}
                  {moreSessionsFailed ? (
                    <p role="alert" className="px-2 pt-2 text-xs text-destructive">
                      {t('sessionsMoreError')}
                    </p>
                  ) : null}
                  {(hasMoreSessions || moreSessionsFailed) && onShowAllSessions ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onShowAllSessions}
                      disabled={loadingMoreSessions}
                      className="mx-2 mt-2"
                    >
                      {loadingMoreSessions
                        ? t('loadingMore')
                        : moreSessionsFailed
                          ? t('retryMore')
                          : t('showAll')}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noSessions')}</p>
              )}
            </DetailCard>
          </>
        )}
      </div>
    </div>
  )
}

function DetailCard({
  title,
  icon,
  className,
  children,
}: {
  title: string
  icon: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('rounded-xl border border-border/75 bg-card p-5 shadow-xs', className)}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  )
}
