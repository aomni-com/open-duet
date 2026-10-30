'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useEffect, useRef, useState } from 'react'

import type { ViewerDescriptor } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { PublicFileSystemProvider } from '../files/lib/public-provider'
import {
  PublishViewerController,
  virtualPathFromPathname,
  type PublishViewerState,
} from './publish-viewer-controller'
import { PublishViewerShell } from './publish-viewer-shell'

/**
 * The client mount for the public publish viewer. It owns nothing an
 * authenticated surface owns: no auth, no session, no React Query, no `SpaApi`.
 * Its only network owner is the anonymous, credentials-omit
 * `PublicFileSystemProvider`, and it delegates all presentation to
 * {@link PublishViewerShell}, which renders the shared `DriveBrowser`/
 * `PreviewPane` in their read-only public modes so a hostile `duet_session`
 * cookie has no seam to ride in on.
 *
 * All URL↔path logic lives in the DOM-free {@link PublishViewerController}; this
 * mount just wires it to `window.history` + `popstate` and hands the settled
 * state to the shell to paint.
 */
export function PublishViewer({
  descriptor,
  workspaceSlug,
  publishSlug,
  initialPath,
}: {
  descriptor: ViewerDescriptor
  workspaceSlug: string
  publishSlug: string
  /** The publish-root-relative virtual path from the route params. */
  initialPath: string
}) {
  const [state, setState] = useState<PublishViewerState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const controllerRef = useRef<PublishViewerController | null>(null)
  const providerRef = useRef<PublicFileSystemProvider | null>(null)

  useEffect(() => {
    // Same-origin as the publish itself: the browser is at the bare public URL
    // (`<origin>/<ws>/<pub>/…`), so the provider's `?raw`/`?list` fetches resolve
    // against the same edge origin with no cross-origin credential exposure.
    const provider = new PublicFileSystemProvider(
      descriptor,
      `${window.location.origin}/${workspaceSlug}/${publishSlug}`,
    )
    providerRef.current = provider
    const controller = new PublishViewerController({
      descriptor,
      workspaceSlug,
      publishSlug,
      provider,
      history: {
        push: (url, virtualPath) => window.history.pushState({ virtualPath }, '', url),
        replace: (url, virtualPath) => window.history.replaceState({ virtualPath }, '', url),
      },
      onChange: setState,
    })
    controllerRef.current = controller
    controller.start(initialPath)

    const onPopState = (event: PopStateEvent) => {
      const statePath = (event.state as { virtualPath?: string } | null)?.virtualPath
      const virtualPath =
        statePath ??
        virtualPathFromPathname(workspaceSlug, publishSlug, window.location.pathname) ??
        '/'
      controller.restore(virtualPath)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      controllerRef.current = null
      providerRef.current = null
    }
  }, [descriptor, workspaceSlug, publishSlug, initialPath])

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <PublishViewerShell
        descriptor={descriptor}
        state={state}
        query={query}
        onQueryChange={setQuery}
        provider={providerRef.current}
        workspaceSlug={workspaceSlug}
        archiveUrl={
          providerRef.current === null ? undefined : path => providerRef.current!.archiveUrl(path)
        }
        onNavigate={path => {
          // Drop the open folder's search filter so it never hides the
          // destination folder's files.
          setQuery('')
          controllerRef.current?.navigate(path)
        }}
        onRetry={() => controllerRef.current?.retry()}
        onLoadMore={() => void controllerRef.current?.loadMore()}
      />
    </NextIntlClientProvider>
  )
}
