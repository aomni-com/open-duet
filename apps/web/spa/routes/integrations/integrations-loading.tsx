'use client'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

import { WorkspacePage } from '../../drive/workspace-page'

export function IntegrationsLoadingView({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-loading-view="integrations"
      className="h-full overflow-hidden bg-background"
    >
      <WorkspacePage className="max-w-5xl">
        <div aria-hidden className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="space-y-2">
            <Skeleton className="size-10 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-80 max-w-[70vw] motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-9 w-28 rounded-md motion-reduce:animate-none" />
        </div>
        <IntegrationsSkeleton />
      </WorkspacePage>
    </div>
  )
}

export function IntegrationsSkeleton() {
  return (
    <div
      aria-hidden
      data-loading-island="integrations-list"
      className="grid gap-5 xl:grid-cols-[1fr_.72fr]"
    >
      <div className="space-y-5">
        <Skeleton className="h-52 rounded-xl motion-reduce:animate-none" />
        <Skeleton className="h-96 rounded-xl motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-96 rounded-xl motion-reduce:animate-none" />
    </div>
  )
}
