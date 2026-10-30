'use client'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

/* Column rows are a fixed height, so a skeleton row is too — and the widths are
   authored rather than random so the silhouette is identical on every cold load
   and cannot flicker between renders. */
const ROOT_ROWS = ['62%', '38%', '74%', '46%', '55%', '30%', '68%', '42%']
const NEXT_ROWS = ['48%', '66%', '34%']

/**
 * The single Drive loading silhouette, rendered by the Next/identity,
 * route-chunk, and file-list boundaries.
 *
 * It is the shape of the thing that is coming: a control strip, the trail
 * beneath it, then columns of rows. A skeleton that shows a different layout
 * than the one it resolves into is worse than no skeleton — the surface visibly
 * rearranges itself the moment the data lands, and the reader has spent the wait
 * orienting around furniture that was never there.
 *
 * A second, fainter column sits behind the first. It says the drive is a stack
 * you walk sideways before anything has loaded, which is the one thing about
 * this surface a newcomer will not guess.
 */
export function DriveSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-loading-view="files"
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      <div aria-hidden className="flex h-full min-h-0 flex-col">
        {/* Control strip */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-3">
          <Skeleton className="h-8 w-20 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-8 w-24 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-8 w-20 rounded-md motion-reduce:animate-none" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md motion-reduce:animate-none" />
            <Skeleton className="h-8 w-40 rounded-md motion-reduce:animate-none" />
            <Skeleton className="h-8 w-16 rounded-md motion-reduce:animate-none" />
          </div>
        </div>

        {/* The trail */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
          <Skeleton className="h-3.5 w-16 motion-reduce:animate-none" />
        </div>

        {/* The stack */}
        <div className="flex min-h-0 flex-1">
          <SkeletonColumn widths={ROOT_ROWS} />
          <SkeletonColumn widths={NEXT_ROWS} faded />
        </div>
      </div>
    </div>
  )
}

function SkeletonColumn({ widths, faded = false }: { widths: string[]; faded?: boolean }) {
  return (
    <div
      className={`flex w-72 shrink-0 flex-col border-r border-border/50 ${faded ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
        <span className="w-8" />
        <Skeleton className="h-2.5 w-12 motion-reduce:animate-none" />
      </div>
      <div className="flex flex-col py-1">
        {widths.map(width => (
          <div key={width} className="flex items-center gap-2 px-3 py-1.5">
            <Skeleton className="size-8 shrink-0 rounded-md motion-reduce:animate-none" />
            <Skeleton className="h-3 rounded-sm motion-reduce:animate-none" style={{ width }} />
          </div>
        ))}
      </div>
    </div>
  )
}
