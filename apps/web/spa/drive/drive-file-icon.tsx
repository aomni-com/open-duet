'use client'

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'

import { duetApi, type DuetApiClient } from '../api/client'

type DriveFileIconClient = Pick<DuetApiClient, 'workspaceFileDownloadUrl'>
type DriveFileIconEntity = {
  anchorPath: string
  icon?: string
  updatedAt: number
}

const DriveFileIconClientContext = createContext<DriveFileIconClient>(duetApi)

export function driveFileIconPath(
  entity: Pick<DriveFileIconEntity, 'anchorPath' | 'icon'>,
): string | undefined {
  return entity.icon === undefined ? undefined : `${entity.anchorPath}/${entity.icon}`
}

export function DriveFileIconClientProvider({
  client,
  children,
}: {
  client: DriveFileIconClient
  children: ReactNode
}) {
  return (
    <DriveFileIconClientContext.Provider value={client}>
      {children}
    </DriveFileIconClientContext.Provider>
  )
}

/**
 * Where the drive serves this entity's icon, as a URL — or nothing, when it has
 * none.
 *
 * One owner, because the answer is three facts joined together (the anchor, the
 * icon's relative path, and the version that busts the cache when it is
 * replaced) and a surface that joins two of them draws a stale or missing
 * picture. The knowledge map is the caller that needs the URL rather than the
 * `<img>`: it draws into SVG, where an `<image href>` is the only way in.
 */
export function useDriveFileIconUrl(
  workspaceSlug: string,
): (entity: DriveFileIconEntity) => string | undefined {
  const client = useContext(DriveFileIconClientContext)
  return useCallback(
    entity => {
      const iconPath = driveFileIconPath(entity)
      return iconPath === undefined
        ? undefined
        : client.workspaceFileDownloadUrl(workspaceSlug, iconPath, { version: entity.updatedAt })
    },
    [client, workspaceSlug],
  )
}

export function DriveFileIcon({
  entity,
  workspaceSlug,
  className,
  fallback,
}: {
  entity: DriveFileIconEntity
  workspaceSlug: string
  className: string
  fallback: ReactNode
}) {
  const iconUrl = useDriveFileIconUrl(workspaceSlug)

  return <FileIconImage src={iconUrl(entity)} className={className} fallback={fallback} />
}

/**
 * An icon file drawn as itself, and its fallback the moment the file cannot be
 * drawn — deleted, unreadable, or never there. One owner for that degrade, so
 * every surface showing a workspace-hosted icon fails the same way.
 */
export function FileIconImage({
  src,
  className,
  fallback,
  ...imageProps
}: Omit<ComponentPropsWithoutRef<'img'>, 'src' | 'className'> & {
  src: string | undefined
  className: string
  fallback: ReactNode
}) {
  const [failedUrl, setFailedUrl] = useState<string>()

  if (src === undefined || src === failedUrl) return fallback

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className={className}
      onError={() => setFailedUrl(src)}
      {...imageProps}
    />
  )
}
