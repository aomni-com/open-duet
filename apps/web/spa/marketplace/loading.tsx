import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

export function MarketplaceLoadingView({
  label,
  layout = 'catalog',
}: {
  label: string
  layout?: 'catalog' | 'marketplace-detail'
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-atomic="true"
      aria-label={label}
      data-loading-view={layout === 'catalog' ? 'marketplace' : 'marketplace-detail'}
      className="h-full min-h-0 w-full"
    >
      <MarketplaceAgentsLoadingContent layout={layout} />
    </div>
  )
}

export function MarketplaceAgentsLoadingContent({
  layout = 'catalog',
}: {
  layout?: 'catalog' | 'marketplace-detail'
}) {
  if (layout === 'marketplace-detail') return <MarketplaceAgentDetailLoadingContent />

  return (
    <div
      aria-hidden="true"
      data-agent-loading-layout="catalog"
      className="mx-auto min-h-full w-full max-w-7xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10 [&_.shell-skeleton]:bg-muted-foreground/20"
    >
      <header className="mx-auto mb-8 flex max-w-2xl flex-col items-center">
        <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
        <Skeleton className="mt-3 h-9 w-72 max-w-[78vw] motion-reduce:animate-none sm:h-10 sm:w-96" />
        <div className="mt-4 flex w-full max-w-lg flex-col items-center gap-2">
          <Skeleton className="h-3.5 w-full motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-4/5 motion-reduce:animate-none" />
        </div>
      </header>

      <section className="grid grid-cols-1 justify-center gap-4 sm:grid-cols-[repeat(auto-fit,minmax(17rem,20rem))]">
        {[0, 1, 2].map(index => (
          <CatalogCardSkeleton key={index} index={index} />
        ))}
      </section>
    </div>
  )
}

function MarketplaceAgentDetailLoadingContent() {
  return (
    <div
      aria-hidden="true"
      data-agent-loading-layout="marketplace-detail"
      className="mx-auto min-h-full w-full max-w-6xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10 [&_.shell-skeleton]:bg-muted-foreground/20"
    >
      <article className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <header className="border-b border-border bg-gradient-to-br from-brand/[0.1] via-card to-card px-5 py-6 sm:px-8 sm:py-8">
          <Skeleton className="mb-5 h-8 w-36 rounded-lg motion-reduce:animate-none" />
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-4">
              <Skeleton className="size-14 shrink-0 rounded-[28%] motion-reduce:animate-none" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-8 w-48 motion-reduce:animate-none" />
                  <Skeleton className="h-6 w-20 rounded-full motion-reduce:animate-none" />
                </div>
                <div className="mt-4 space-y-2">
                  <Skeleton className="h-3.5 w-[min(34rem,62vw)] motion-reduce:animate-none" />
                  <Skeleton className="h-3.5 w-[min(26rem,52vw)] motion-reduce:animate-none" />
                </div>
              </div>
            </div>
            <Skeleton className="ml-[4.5rem] h-9 w-28 rounded-lg motion-reduce:animate-none sm:ml-0" />
          </div>
        </header>

        <div className="grid gap-8 px-5 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-12">
          <section>
            <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
            <Skeleton className="mt-2 h-6 w-36 motion-reduce:animate-none" />
            <div className="mt-6 space-y-3">
              <Skeleton className="h-4 w-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-3/4 motion-reduce:animate-none" />
              <Skeleton className="mt-5 h-4 w-5/6 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
            </div>
          </section>
          <aside>
            <Skeleton className="h-4 w-16 motion-reduce:animate-none" />
            <div className="mt-3 flex flex-wrap gap-2 lg:flex-col">
              <Skeleton className="h-10 w-28 rounded-xl motion-reduce:animate-none lg:w-full" />
              <Skeleton className="h-10 w-32 rounded-xl motion-reduce:animate-none lg:w-full" />
              <Skeleton className="h-10 w-24 rounded-xl motion-reduce:animate-none lg:w-full" />
            </div>
          </aside>
        </div>
      </article>
    </div>
  )
}

function CatalogCardSkeleton({ index }: { index: number }) {
  const descriptionWidths = ['w-full', 'w-11/12', 'w-4/5'] as const
  return (
    <article className="flex min-h-[17rem] flex-col overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="size-12 rounded-[28%] motion-reduce:animate-none" />
        <Skeleton className="h-7 w-24 rounded-full motion-reduce:animate-none" />
      </div>

      <div className="mt-5 min-w-0 flex-1">
        <Skeleton className="h-5 w-32 motion-reduce:animate-none" />
        <div className="mt-3 space-y-2">
          <Skeleton
            className={`h-3.5 ${descriptionWidths[index] ?? 'w-full'} motion-reduce:animate-none`}
          />
          <Skeleton className="h-3.5 w-full motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-3/5 motion-reduce:animate-none" />
        </div>
        <div className="mt-5 flex gap-2">
          <Skeleton className="h-7 w-20 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-7 w-24 rounded-md motion-reduce:animate-none" />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 rounded-[35%] motion-reduce:animate-none" />
          <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
        </div>
        <Skeleton className="h-8 w-24 rounded-lg motion-reduce:animate-none" />
      </div>
    </article>
  )
}
