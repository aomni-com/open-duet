'use client'

import type { ReactNode } from 'react'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

import { DuetLoadingCue } from '../../components/brand/duet-mark'

export function AgentsWorkspaceLoadingFrame({
  view,
  label,
  children,
}: {
  view:
    | 'session-new'
    | 'session-detail'
    | 'apps'
    | 'marketplace'
    | 'marketplace-detail'
    | 'agent-detail'
  label: string
  children: ReactNode
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-loading-view={view}
      className="h-full min-h-0 min-w-0 overflow-hidden bg-background"
    >
      {children}
    </div>
  )
}

/* A `section`, not a `main`. Both of these mount inside a page that already
   owns the document's landmark — the agents section does, and so does every
   other host — so a `main` here nested one inside another, which is invalid and
   leaves a screen reader with two "main" landmarks to choose between. The
   `aria-label` is what actually carries the wait's identity, and it survives
   the change; see `spa/loading/README.md` on why every page-level wait names
   itself. */
export function SessionWelcomeSkeleton({ label }: { label: string }) {
  return (
    <section
      aria-label={label}
      className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center overflow-hidden bg-background p-5 md:p-8"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-brand/[0.06] via-brand/[0.02] to-transparent"
      />
      <div aria-hidden className="w-full max-w-2xl space-y-5">
        <DuetLoadingCue label={label} className="mx-auto" />
        <div className="mx-auto flex w-72 max-w-[80%] flex-col items-center gap-2">
          <Skeleton className="h-4 w-36 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-56 max-w-full motion-reduce:animate-none" />
        </div>
        <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
          <Skeleton className="h-4 w-48 max-w-[65%] motion-reduce:animate-none" />
          <Skeleton className="mt-8 h-4 w-4/5 motion-reduce:animate-none" />
          <div className="mt-6 flex items-center justify-between">
            <Skeleton className="h-8 w-32 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </section>
  )
}

export function SessionDetailSkeleton({ label }: { label: string }) {
  return (
    <section
      aria-label={label}
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-brand/[0.07] via-brand/[0.03] to-transparent"
      />
      <header className="relative flex min-h-14 items-center gap-3 border-b border-border/40 bg-background/70 px-3 backdrop-blur-md md:px-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-4 w-52 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
        </div>
        <Skeleton className="h-9 w-24 rounded-lg motion-reduce:animate-none" />
        <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden py-5">
        <div className="mx-auto max-w-4xl space-y-6 px-4 md:px-6">
          <div className="ml-auto max-w-[78%] space-y-2 rounded-2xl rounded-br-md border border-border/50 bg-card/70 p-4">
            <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-full motion-reduce:animate-none" />
            <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
          </div>
          <div className="flex max-w-[82%] gap-3">
            <Skeleton className="size-8 shrink-0 rounded-[28%] motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
            </div>
          </div>
          <div className="flex max-w-[70%] gap-3 opacity-70">
            <Skeleton className="size-8 shrink-0 rounded-[28%] motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      </div>
      <footer className="relative z-10 bg-background px-3 pb-3 pt-2 md:px-5 md:pb-4">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
          <Skeleton className="h-5 w-2/3 motion-reduce:animate-none" />
          <div className="mt-8 flex items-center justify-between">
            <Skeleton className="h-8 w-28 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
          </div>
        </div>
      </footer>
    </section>
  )
}
