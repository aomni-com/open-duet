'use client'

import { ArrowUUpLeftIcon, DotsThreeIcon } from '@phosphor-icons/react'

import { cn } from '@repo/ui/lib/utils'

import { FixtureApp } from '../agent-surface-busy-fixture'
import type { TeamApp } from './team-space-fixture'
import { MemberFace } from './team-space-parts'
import { useWorkspace, useMember } from './team-space-workspace'

/**
 * An app's own mark.
 *
 * The bytes come from the workspace fixture rather than from each surface, because
 * the dock, the grid and the knowledge map all draw the same app and a tile
 * that differs between them is three answers to one question. Painted as a
 * background rather than an `<img>`: it is decoration with a label beside it
 * everywhere it appears, so it carries no alternative text of its own.
 */
export function AppArt({ app, className }: { app: TeamApp; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ backgroundImage: `url("${app.art}")` }}
      className={cn('block shrink-0 rounded-lg bg-cover bg-center ring-1 ring-black/10', className)}
    />
  )
}

/**
 * What Home offers under the compose bar.
 *
 * The chats used to be here and they were the wrong answer twice over: the
 * column already lists them, and a chat is where work is *discussed* rather than
 * where it is done. What a client bought is the apps, so Home is where they
 * are, and each one carries the agent that keeps it fed — which is who you talk
 * to when it is wrong.
 */
export function AppGrid({ onOpenApp }: { onOpenApp: (id: string) => void }) {
  const workspace = useWorkspace()
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {workspace.apps.map(app => (
        <li key={app.id}>
          <AppCard app={app} onOpen={() => onOpenApp(app.id)} />
        </li>
      ))}
    </ul>
  )
}

function AppCard({ app, onOpen }: { app: TeamApp; onOpen: () => void }) {
  const owner = useMember(app.ownerAgentId)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full items-start gap-3 rounded-xl border border-border/75 bg-card p-3 text-left transition-colors hover:border-border hover:bg-muted/30"
    >
      <AppArt app={app} className="size-10" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{app.name}</span>
        <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-muted-foreground">
          {app.blurb}
        </span>
        <span className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {owner ? <MemberFace member={owner} className="size-4" /> : null}
          <span className="truncate">{owner?.name}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 truncate">{app.meta}</span>
        </span>
      </span>
    </button>
  )
}

/**
 * One app, open.
 *
 * The body is a stand-in — an app is whatever its agent built, and this fixture
 * has no opinion about that. What is not a stand-in is the frame: an app on this
 * workspace is never anonymous software, it is something an agent maintains, so the
 * header names that agent and offers the one thing a person actually wants when
 * an app is wrong, which is to say so to whoever owns it.
 */
export function TeamSpaceAppPane({ app, onBack }: { app: TeamApp; onBack: () => void }) {
  const owner = useMember(app.ownerAgentId)
  return (
    <>
      <header className="flex h-12 shrink-0 items-center border-b border-border/70">
        <div className="mx-auto flex w-full max-w-[60rem] items-center gap-2 px-4 sm:px-6">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to Home"
            className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <ArrowUUpLeftIcon className="size-4" />
          </button>
          <AppArt app={app} className="size-6" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{app.name}</span>
          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            {owner ? <MemberFace member={owner} className="size-4" /> : null}
            Kept by {owner?.name}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Ask {owner?.name}
          </button>
          <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
            <DotsThreeIcon className="size-4" />
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/25">
        <div className="mx-auto w-full max-w-[60rem] p-4 sm:p-6">
          <div className="overflow-hidden rounded-xl border border-border/75">
            <FixtureApp title={app.name} />
          </div>
        </div>
      </div>
    </>
  )
}
