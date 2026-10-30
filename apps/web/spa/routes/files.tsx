'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'

import { driveFolderUrl, filesBrowserPathFromPathname } from '../drive/drive-routes'
import { browserPathFromAnchorPath } from '../files/lib/paths'
import { WorkspaceDrive } from '../files/workspace-drive'
import { RecipientShareRequests } from '../shares/recipient-requests'

export function createFilesRouteNavigator(
  workspaceSlug: string,
  navigate: (route: string, options: { replace: boolean }) => void,
): (path: string, options?: { replace?: boolean }) => void {
  return (path, options) =>
    navigate(driveFolderUrl(workspaceSlug, path), {
      replace: options?.replace ?? false,
    })
}

export function createShareAcceptedHandler(
  currentWorkspaceSlug: string,
  refreshCurrentWorkspace: (browserPath: string) => void,
  navigate: (
    route: string,
    options: { replace: boolean; state?: { acceptedMountPath: string } },
  ) => void,
): (workspaceSlug: string, mountPath: string) => void {
  return (workspaceSlug, mountPath) => {
    const browserPath = browserPathFromAnchorPath(mountPath)
    if (workspaceSlug === currentWorkspaceSlug) refreshCurrentWorkspace(browserPath)
    navigate(driveFolderUrl(workspaceSlug, browserPath), {
      replace: true,
      state: { acceptedMountPath: browserPath },
    })
  }
}

export default function FilesRoute() {
  const { workspaceSlug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [filesRevision, setFilesRevision] = useState(0)
  const refreshOnPath = useRef<string | undefined>(undefined)
  const filesNavigator = useMemo(
    () => createFilesRouteNavigator(workspaceSlug, navigate),
    [navigate, workspaceSlug],
  )
  const path = filesBrowserPathFromPathname(location.pathname, workspaceSlug)
  const acceptedMountPath =
    typeof location.state === 'object' &&
    location.state !== null &&
    'acceptedMountPath' in location.state &&
    typeof location.state.acceptedMountPath === 'string'
      ? location.state.acceptedMountPath
      : undefined
  useEffect(() => {
    if (path === null || refreshOnPath.current !== path) return
    // Changing the key before navigation settles remounts Files at the old path and starts a stale
    // listing. Arm the refresh in a ref, then remount only after the accepted path is current.
    refreshOnPath.current = undefined
    setFilesRevision(revision => revision + 1)
  }, [path])
  const acceptShare = createShareAcceptedHandler(
    workspaceSlug,
    targetPath => {
      if (targetPath === path) setFilesRevision(revision => revision + 1)
      else refreshOnPath.current = targetPath
    },
    navigate,
  )
  return (
    <>
      <RecipientShareRequests
        workspaceSlug={workspaceSlug}
        focusedShareId={searchParams.get('shareRequest') ?? undefined}
        unavailableLink={searchParams.get('shareLink') === 'unavailable'}
        onAccepted={acceptShare}
      />
      <WorkspaceDrive
        key={`${workspaceSlug}:${filesRevision}`}
        workspaceSlug={workspaceSlug}
        path={path}
        onNavigate={filesNavigator}
        retryNotFound={acceptedMountPath === path}
      />
    </>
  )
}
