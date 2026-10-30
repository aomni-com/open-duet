import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

export function AgentDetailLoadingSkeleton() {
  return (
    <main
      /* Content only: `AgentsWorkspaceLoadingFrame` owns `data-loading-view`
         and the status announcement, and a second copy of that hook inside it
         is what a reader (or a test) resolves to instead of the frame. */
      aria-hidden="true"
      data-agent-loading-layout="agent-detail"
      className="block h-full min-w-0 overflow-hidden bg-background [&_.shell-skeleton]:bg-muted-foreground/20"
    >
      <div className="mx-auto max-w-5xl p-4 pb-24 sm:p-6 lg:p-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-12 shrink-0 rounded-[28%] motion-reduce:animate-none" />
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-7 w-44 motion-reduce:animate-none" />
                <Skeleton className="size-2 rounded-full motion-reduce:animate-none" />
              </div>
              <Skeleton className="h-3.5 w-64 max-w-[60vw] motion-reduce:animate-none" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-20 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="h-9 w-28 rounded-lg motion-reduce:animate-none" />
            <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
          </div>
        </header>

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-3">
          <DetailCardSkeleton className="lg:col-span-1" lines={2} />
          <DetailCardSkeleton className="lg:col-span-2" lines={1} chips />
        </div>
        <DetailCardSkeleton className="mt-4" lines={4} />
        <DetailCardSkeleton className="mt-4" lines={1} tiles />
        <DetailCardSkeleton className="mt-4" lines={3} rows />
      </div>
    </main>
  )
}

function DetailCardSkeleton({
  className,
  lines,
  chips = false,
  tiles = false,
  rows = false,
}: {
  className?: string
  lines: number
  chips?: boolean
  tiles?: boolean
  rows?: boolean
}) {
  return (
    <section className={`rounded-xl border border-border bg-card p-5 shadow-sm ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <Skeleton className="size-4 rounded-[35%] motion-reduce:animate-none" />
        <Skeleton className="h-4 w-20 motion-reduce:animate-none" />
      </div>
      <div className="mt-4">
        {chips ? (
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-6 w-20 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-6 w-24 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-6 w-16 rounded-full motion-reduce:animate-none" />
          </div>
        ) : tiles ? (
          <div className="flex gap-2">
            {[0, 1, 2].map(index => (
              <div
                key={index}
                className="flex w-20 flex-col items-center gap-2 rounded-lg border border-border/80 bg-background/65 p-2.5"
              >
                <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
                <Skeleton className="h-2.5 w-12 motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        ) : rows ? (
          <div className="space-y-2">
            {[0, 1, 2].map(index => (
              <div key={index} className="flex h-8 items-center gap-2 px-2">
                <Skeleton className="size-1.5 rounded-full motion-reduce:animate-none" />
                <Skeleton
                  className={`${index === 1 ? 'w-2/3' : index === 2 ? 'w-1/2' : 'w-4/5'} h-3 motion-reduce:animate-none`}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: lines }, (_, index) => (
              <Skeleton
                key={index}
                className={`${index === lines - 1 ? 'w-3/5' : 'w-full'} h-3.5 motion-reduce:animate-none`}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
