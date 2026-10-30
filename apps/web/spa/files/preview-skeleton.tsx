'use client'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

/**
 * Viewer-shaped placeholder for an open document: header chrome over a
 * resolving canvas. Shared by the dialog's chunk-load fallback and the
 * pane's own data-load state so the silhouette never changes mid-open.
 */
export function PreviewSkeleton() {
  return (
    <div data-files-preview-skeleton className="flex min-h-[60vh] flex-col">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b px-4 py-2 pr-12">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Skeleton className="h-4 w-44 max-w-full" />
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-9" />
          <Skeleton className="h-8 w-9" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/15 p-4">
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    </div>
  )
}

/** Flowing-text placeholder for markdown and other prose renders. */
export function ProseSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 p-4 md:p-6">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-4 w-10/12" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  )
}
