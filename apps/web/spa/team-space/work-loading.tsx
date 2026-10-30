'use client'

import type { ComponentProps } from 'react'

import { Skeleton as BaseSkeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { AppFramePlaceholder } from '../apps/app-frame'
import type { WorkLoadingView } from '../loading/loading-route'

type WorkLoadingProps = {
  view: WorkLoadingView
  label: string
  sessionAsking?: boolean
}

function Skeleton({ className, ...props }: ComponentProps<typeof BaseSkeleton>) {
  return (
    <BaseSkeleton
      className={cn('bg-foreground/10 motion-reduce:animate-none', className)}
      {...props}
    />
  )
}

export function WorkBootstrapShell({ view, label, sessionAsking }: WorkLoadingProps) {
  return (
    <div
      data-team-space-loading="work"
      data-loading-view={view}
      role="status"
      aria-busy="true"
      aria-label={label}
      className="km-hues flex h-[var(--product-viewport-height,100dvh)] min-h-0 w-full overflow-hidden bg-background text-foreground"
    >
      <WorkLoadingSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkLoadingMobileHeader />
        <WorkLoadingContent view={view} sessionAsking={sessionAsking} />
        {view === 'work-home' ? <WorkLoadingMobileNav /> : null}
      </div>
    </div>
  )
}

export function WorkLoadingIsland({ view, label, sessionAsking }: WorkLoadingProps) {
  return (
    <section
      data-loading-view={view}
      role="status"
      aria-busy="true"
      aria-label={label}
      className="h-full min-h-0 min-w-0 overflow-hidden bg-background"
    >
      <WorkLoadingContent view={view} sessionAsking={sessionAsking} />
    </section>
  )
}

function WorkLoadingSidebar() {
  return (
    <aside
      aria-hidden
      className="hidden w-[17rem] shrink-0 flex-col border-r border-border/70 bg-sidebar lg:flex"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Skeleton className="size-7 rounded-[28%] motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
      </div>
      <div className="px-2.5 py-2">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/70 p-0.5">
          <Skeleton className="h-7 rounded-[5px] bg-background motion-reduce:animate-none" />
          <Skeleton className="h-7 rounded-[5px] motion-reduce:animate-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3">
        <Skeleton className="h-8 w-full rounded-md motion-reduce:animate-none" />
        <Skeleton className="mb-2 mt-6 h-2.5 w-12 motion-reduce:animate-none" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-full rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-7 w-5/6 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-7 w-3/4 rounded-md motion-reduce:animate-none" />
        </div>
      </div>
      <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border/70 px-3">
        <Skeleton className="size-7 rounded-[28%] motion-reduce:animate-none" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-2.5 w-14 motion-reduce:animate-none" />
        </div>
        <Skeleton className="size-8 rounded-md motion-reduce:animate-none" />
      </div>
    </aside>
  )
}

function WorkLoadingMobileHeader() {
  return (
    <header
      aria-hidden
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 lg:hidden"
    >
      <Skeleton className="size-8 rounded-[28%] motion-reduce:animate-none" />
      <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
      <span className="flex-1" />
      <Skeleton className="h-9 w-16 rounded-lg motion-reduce:animate-none" />
    </header>
  )
}

function WorkLoadingContent({
  view,
  sessionAsking,
}: {
  view: WorkLoadingView
  sessionAsking?: boolean
}) {
  if (view === 'work-session') return <WorkSessionLoading asking={sessionAsking} />
  if (view === 'work-app') return <WorkAppLoading />
  return <WorkHomeLoading />
}

function WorkHomeLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        aria-hidden
        className="hidden h-12 shrink-0 items-center border-b border-border/70 lg:flex"
      >
        <div className="mx-auto flex w-full max-w-[46rem] items-center px-5">
          <Skeleton className="h-3.5 w-12 motion-reduce:animate-none" />
          <span className="flex-1" />
          <Skeleton className="h-8 w-16 rounded-md motion-reduce:animate-none" />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div aria-hidden className="mx-auto w-full max-w-[46rem] px-5 pb-28 pt-9 sm:pt-14 lg:pb-20">
          <Skeleton className="h-2.5 w-40 motion-reduce:animate-none" />
          <Skeleton className="mt-3 h-9 w-72 max-w-[80%] motion-reduce:animate-none" />
          <Skeleton className="mt-3 h-3.5 w-[28rem] max-w-full" />
          <Skeleton className="mt-2 h-3.5 w-[17rem] max-w-[72%] sm:hidden" />
          <div className="mt-6 overflow-hidden rounded-xl border border-border/75 bg-card shadow-[0_1px_0_hsl(var(--foreground)/0.025)]">
            <div className="flex h-8 items-center px-3">
              <Skeleton className="h-3.5 w-36" />
              <span className="flex-1" />
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="flex h-10 items-center gap-2 border-t border-border/60 px-3">
              <Skeleton className="size-6 rounded-md" />
              <Skeleton className="h-3.5 w-40 max-w-[62%]" />
              <span className="flex-1" />
              <Skeleton className="size-6 rounded-md" />
            </div>
            <div className="min-h-32 border-t border-border/60 p-3">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="mt-2 h-3.5 w-2/5" />
              <div className="mt-12 flex items-center justify-between">
                <div className="flex gap-1.5">
                  <Skeleton className="size-8 rounded-md" />
                  <Skeleton className="size-8 rounded-md" />
                </div>
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[100, 132, 140, 120].map(width => (
              <Skeleton
                key={width}
                style={{ width }}
                className="h-11 rounded-full motion-reduce:animate-none lg:h-7"
              />
            ))}
          </div>
          <div className="mb-2 mt-8 flex items-center gap-2 sm:mt-10">
            <Skeleton className="h-2.5 w-32 motion-reduce:animate-none" />
            <span className="h-px flex-1 bg-border/60" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-28 rounded-xl motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkSessionLoading({ asking = false }: { asking?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        aria-hidden
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-3 sm:px-4"
      >
        <Skeleton className="size-10 rounded-md motion-reduce:animate-none lg:hidden" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-48 max-w-[60%] motion-reduce:animate-none" />
          <Skeleton className="h-2.5 w-28 motion-reduce:animate-none" />
        </div>
        <Skeleton className="h-9 w-24 rounded-md motion-reduce:animate-none" />
      </header>
      <WorkSessionBodyLoading asking={asking} />
    </div>
  )
}

export function WorkSessionBodyLoading({
  asking = false,
  label,
}: {
  asking?: boolean
  label?: string
}) {
  return (
    <div
      data-session-asking={asking ? 'true' : undefined}
      role={label === undefined ? undefined : 'status'}
      aria-busy={label === undefined ? undefined : 'true'}
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <div aria-hidden className="min-h-0 flex-1 overflow-hidden px-4 py-5 sm:px-5 sm:py-6">
        <div className="mx-auto max-w-4xl space-y-7">
          <div className="ml-auto w-[58%] space-y-2">
            <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
            <Skeleton className="h-16 rounded-xl motion-reduce:animate-none" />
          </div>
          <div className="w-[76%] space-y-2">
            <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-full motion-reduce:animate-none" />
            <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
          </div>
          <div className="w-[68%] space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-24 rounded-xl" />
            <div className="flex gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <div className="w-[82%] space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </div>
      <footer
        aria-hidden
        data-work-loading-composer-footer="true"
        className="relative z-10 shrink-0 bg-background px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
      >
        <div className="mx-auto max-w-4xl">
          {asking ? (
            <div
              data-work-loading-question="true"
              className="mx-2 mb-2 overflow-hidden rounded-xl border border-border/75 bg-card sm:mx-0"
            >
              <div className="flex h-12 items-center gap-2 border-b border-border/60 px-3">
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
                <span className="flex-1" />
                <Skeleton className="h-11 w-16 rounded-md md:h-8" />
              </div>
              <div className="p-3">
                <Skeleton className="h-4 w-4/5" />
                <div className="mt-3 space-y-2">
                  {Array.from({ length: 3 }, (_, index) => (
                    <div
                      key={index}
                      className="flex h-11 items-center gap-2 rounded-lg bg-muted/25 px-2"
                    >
                      <Skeleton className="size-5 rounded-md" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className={cn('h-3.5', index === 1 ? 'w-36' : 'w-44')} />
                        <Skeleton className="h-2.5 w-4/5" />
                      </div>
                    </div>
                  ))}
                  <Skeleton className="h-11 w-full rounded-lg" />
                </div>
              </div>
            </div>
          ) : null}
          <div
            data-work-loading-compose-surface="true"
            className="overflow-hidden rounded-xl border border-border/75 bg-card"
          >
            <div className="flex h-8 items-center gap-2 border-b border-border/60 px-3">
              <Skeleton className="size-6 rounded-md" />
              <Skeleton className="h-3.5 w-40 max-w-[55%]" />
            </div>
            <div className="min-h-20 p-3">
              <Skeleton className="h-4 w-2/3" />
              <div className="mt-8 flex items-center justify-between">
                <div className="flex gap-1.5">
                  <Skeleton className="size-8 rounded-md" />
                  <Skeleton className="size-8 rounded-md" />
                </div>
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

function WorkAppLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        aria-hidden
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4"
      >
        <Skeleton className="size-10 rounded-md motion-reduce:animate-none lg:hidden" />
        <Skeleton className="size-6 rounded-[28%] motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-40 motion-reduce:animate-none" />
        <span className="flex-1" />
        <Skeleton className="h-7 w-16 rounded-full motion-reduce:animate-none" />
        <Skeleton className="size-8 rounded-md motion-reduce:animate-none" />
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AppFramePlaceholder announce={false} />
      </div>
    </div>
  )
}

function WorkLoadingMobileNav() {
  return (
    <nav
      aria-hidden
      className="grid h-16 shrink-0 grid-cols-3 border-t border-border/70 bg-sidebar pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="grid place-items-center">
          <div className="flex flex-col items-center gap-1">
            <Skeleton className="size-5 rounded-md motion-reduce:animate-none" />
            <Skeleton
              className={cn('h-2 rounded motion-reduce:animate-none', index === 0 ? 'w-8' : 'w-10')}
            />
          </div>
        </div>
      ))}
    </nav>
  )
}
