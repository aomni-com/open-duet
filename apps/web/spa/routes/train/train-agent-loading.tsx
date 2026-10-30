'use client'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

/* The Train route, while it resolves which agent's memory it is about. It was
   the deleted Apps page's skeleton, borrowed — this is its only caller now, so
   it lives here and is named for what it frames. */
export function TrainAgentLoadingSkeleton({ label }: { label: string }) {
  return (
    <main
      aria-label={label}
      data-loading-island="train-agent"
      className="h-full min-w-0 overflow-hidden bg-background px-4 py-5 sm:px-6 sm:py-7"
    >
      <div aria-hidden className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-72 max-w-[65vw] motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-9 w-28 rounded-lg motion-reduce:animate-none" />
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="size-11 rounded-lg motion-reduce:animate-none" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-44 motion-reduce:animate-none" />
                <Skeleton className="h-3 w-64 max-w-full motion-reduce:animate-none" />
              </div>
            </div>
            <Skeleton className="h-32 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="h-40 rounded-lg motion-reduce:animate-none" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-36 rounded-xl motion-reduce:animate-none" />
            <Skeleton className="h-52 rounded-xl motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </main>
  )
}
