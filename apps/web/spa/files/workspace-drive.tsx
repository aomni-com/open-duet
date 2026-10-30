'use client'

/* ============================================================================
   The drive, wired to a live workspace.

   `FilesSurface` is presentation over three seams it does not build. Two arrive
   as props: the file system to read, and the share API. The third — the
   workspace's app list, which is how a folder an app is anchored to draws as
   that app rather than as a folder — arrives through context, and the hooks
   that read it *throw* when nobody supplied it. So a mount point that brings
   the file system and forgets the apps does not degrade to a drive without
   apps; it takes the whole destination down to the route boundary.

   Which is why the assembly lives here rather than at each mount point. The two
   that exist — the drive's own destination, and the drive opened on an agent
   inside the map's agent card — differ only in where the path lives: the
   address bar on the destination, card state inside the agent. That is all they
   pass.
   ========================================================================= */
import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router'

import type { App } from '@repo/contract'

import { duetQueryOptions } from '../api/query-options'
import { appProductUrl } from '../apps/app-location'
import { useSpa } from '../context'
import { useStorageFullNotifier } from '../entitlements/storage-warning'
import { WorkspaceAppsProvider } from './apps-context'
import type { DriveChrome } from './drive-toolbar'
import { FilesSurface } from './files-surface'
import { RestWorkspaceAppsSource } from './lib/apps-source'
import { RestFileSystemProvider } from './lib/rest-provider'

export function WorkspaceDrive({
  workspaceSlug,
  path,
  onNavigate,
  retryNotFound,
  chrome,
}: {
  workspaceSlug: string
  /** null when the address names no folder of this drive — malformed, or foreign */
  path: string | null
  onNavigate(path: string, options?: { replace?: boolean }): void
  retryNotFound?: boolean
  /** whether the drive is the page or a guest — see `DriveChrome` */
  chrome?: DriveChrome
}) {
  const { api } = useSpa()
  const navigate = useNavigate()
  const notifyStorageFull = useStorageFullNotifier(workspaceSlug)
  const provider = useMemo(
    () =>
      new RestFileSystemProvider(workspaceSlug, api, error =>
        notifyStorageFull({ kind: 'file', error }),
      ),
    [api, notifyStorageFull, workspaceSlug],
  )
  const appsSource = useMemo(() => new RestWorkspaceAppsSource(api), [api])
  /* An app lives under the agent whose folder encloses it, so opening one from
     the drive means resolving that owner first — `groupAppsByAgent` is the same
     containment rule the map draws its fans by, so a row here and a node out
     there lead to the same place. An app no agent claims is the drive's own, and
     the drive's own agent is `root`.

     Always an in-product route: a private app's own URL refuses every viewer.
     A broken app leads to the same place as a working one — its card explains
     what happened, and there is no longer a repair page to send it to. */
  const agents = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const agentRows = agents.data?.items
  const appNavigator = useMemo(
    () => ({
      openApp: (app: App) => {
        navigate(appProductUrl(workspaceSlug, app, agentRows ?? []))
      },
    }),
    [agentRows, navigate, workspaceSlug],
  )
  const deleteApp = useCallback(
    async (targetWorkspaceSlug: string, appSlug: string) => {
      await api.deleteApp(targetWorkspaceSlug, appSlug)
    },
    [api],
  )

  return (
    <WorkspaceAppsProvider source={appsSource} navigator={appNavigator} deleteApp={deleteApp}>
      <FilesSurface
        provider={provider}
        shareApi={api}
        workspaceSlug={workspaceSlug}
        path={path}
        onNavigate={onNavigate}
        chrome={chrome}
        retryNotFound={retryNotFound}
      />
    </WorkspaceAppsProvider>
  )
}
