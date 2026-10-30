import { buttonVariants } from '@repo/ui/components/shadcn/button'

export function CollectionLoadMore({
  loading = false,
  failed = false,
  failureMessage,
  labels,
  onLoad,
}: {
  loading?: boolean
  failed?: boolean
  failureMessage?: string
  labels: { load: string; loading: string; retry: string }
  onLoad: () => void
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      {failed && failureMessage !== undefined ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {failureMessage}
        </p>
      ) : null}
      <button
        type="button"
        disabled={loading}
        onClick={onLoad}
        className={buttonVariants({ variant: 'outline' })}
      >
        {loading ? labels.loading : failed ? labels.retry : labels.load}
      </button>
    </div>
  )
}
