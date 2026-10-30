'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { browserPathToDrivePath, type App } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { collectionPagesQueryOptions } from '../api/query-options'
import type { IWorkspaceAppsSource } from './lib/apps-source'

export type AppNavigator = {
  /**
   * Open an app, given the app rather than a route.
   *
   * The drive used to hand over a finished URL, which meant it had to know that
   * an app has an address at all. It does not: an app belongs to whichever
   * agent's folder encloses it, so the address is `…/agents/:owner/apps/:slug`
   * and resolving the owner needs the agent roster — something a file browser
   * has no business holding. The host does hold it, so the host decides.
   */
  openApp(app: App): void
}

type WorkspaceAppsConfig = {
  source: IWorkspaceAppsSource
  navigator: AppNavigator
  deleteApp(workspaceSlug: string, appSlug: string): Promise<void>
}

const WorkspaceAppsContext = createContext<WorkspaceAppsConfig | undefined>(undefined)

export function WorkspaceAppsProvider({
  source,
  navigator,
  deleteApp,
  children,
}: WorkspaceAppsConfig & { children: ReactNode }) {
  const value = useMemo(() => ({ source, navigator, deleteApp }), [deleteApp, navigator, source])
  return <WorkspaceAppsContext.Provider value={value}>{children}</WorkspaceAppsContext.Provider>
}

export function directoryAppsQueryOptions(
  source: IWorkspaceAppsSource,
  workspaceSlug: string,
  browserPath: string,
) {
  const path = browserPathToDrivePath(browserPath)
  return collectionPagesQueryOptions({
    queryKey: duetQueryKeys.workspaces.apps.children(workspaceSlug, path),
    queryFn: request => source.listApps(workspaceSlug, { ...request, path, scope: 'children' }),
    // The owning surface exposes retry explicitly. Hidden transport retries
    // would leave the control saying Loading while repeating the same failed
    // continuation behind the reader's back.
    retry: false,
  })
}

export function useDirectoryApps(workspaceSlug: string, browserPath: string) {
  const { source } = useWorkspaceApps()
  const options = directoryAppsQueryOptions(source, workspaceSlug, browserPath)
  return { query: useInfiniteQuery(options), queryKey: options.queryKey }
}

export function useAppNavigator() {
  return useWorkspaceApps().navigator
}

export function useDeleteApp() {
  return useWorkspaceApps().deleteApp
}

function useWorkspaceApps(): WorkspaceAppsConfig {
  const value = useContext(WorkspaceAppsContext)
  if (value === undefined) throw new Error('WorkspaceAppsProvider is required')
  return value
}
