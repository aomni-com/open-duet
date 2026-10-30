// Public publish viewer route.
//
// This route lives OUTSIDE the `(product)` route group on purpose: it must never
// mount `AuthProvider`, never read a session, and never make an authenticated
// API call. It imports no auth/session symbol.
//
// The only trusted input beyond the URL is the edge-injected, already-validated
// `x-duet-viewer-descriptor` header (the edge strips every caller credential
// before proxying here). We re-parse it through the shared schema so a missing
// or malformed header degrades to a not-found shape rather than crashing, and
// then hand the descriptor to the client controller, which owns all data
// fetching through the anonymous `PublicFileSystemProvider`.

import { headers } from 'next/headers'

import { DUET_VIEWER_DESCRIPTOR_HEADER, parseViewerDescriptor } from '@repo/contract'

import { PublishViewer } from '@/spa/publish/publish-viewer'

type PublishViewerParams = {
  workspaceSlug: string
  publishSlug: string
  path?: string[]
}

export default async function PublishViewerPage({
  params,
}: {
  params: Promise<PublishViewerParams>
}) {
  const { workspaceSlug, publishSlug, path } = await params
  const requestHeaders = await headers()
  const descriptor = parseViewerDescriptor(requestHeaders.get(DUET_VIEWER_DESCRIPTOR_HEADER))

  if (descriptor === null) {
    // No valid identity from the edge — this URL is not a resolvable publish.
    return (
      <main
        data-publish-viewer
        className="flex min-h-[100dvh] items-center justify-center bg-background p-8 text-center text-foreground"
      >
        <div className="space-y-3">
          <p className="font-medium">Not found</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            This publish does not exist or is no longer available.
          </p>
        </div>
      </main>
    )
  }

  const initialPath = `/${(path ?? []).join('/')}`

  return (
    <PublishViewer
      descriptor={descriptor}
      workspaceSlug={workspaceSlug}
      publishSlug={publishSlug}
      initialPath={initialPath}
    />
  )
}
