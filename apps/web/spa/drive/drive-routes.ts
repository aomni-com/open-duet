import { ROOT_AGENT_SCOPE } from '@repo/contract'

import {
  browserPathFromAnchorPath,
  encodeBrowserFilePath,
  normalizeBrowserFilePath,
} from '../files/lib/paths'
import { agentsMapUrl, isMapPath } from './agents-map-url'

/* Four, and they are the four the bar carries. `jobs` was another route with no
   button, and it is gone with the destination it named: work is a session, a
   session belongs to an agent, and an agent's work is read on that agent's own
   surface rather than on a drive-wide page. */
export type DriveTab = 'agents' | 'files' | 'desktop' | 'integrations'

const workspaceRoot = (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}`

export function driveFolderUrl(workspaceSlug: string, browserPath: string): string {
  return driveFilesUrl(workspaceSlug, browserPath, true)
}

export function driveFileUrl(workspaceSlug: string, browserFilePath: string): string {
  return driveFilesUrl(workspaceSlug, browserFilePath, false)
}

export function filesBrowserPathFromPathname(
  pathname: string,
  workspaceSlug: string,
): string | null {
  const segments = pathname.split('/')
  if (segments[0] !== '' || segments[1] !== 'w' || segments[3] !== 'files') return null

  let decodedWorkspace: string
  try {
    decodedWorkspace = decodeURIComponent(segments[2] ?? '')
  } catch {
    return null
  }
  if (decodedWorkspace !== workspaceSlug) return null

  const encodedPathSegments = segments.slice(4)
  while (encodedPathSegments.at(-1) === '') encodedPathSegments.pop()
  if (encodedPathSegments.length === 0) return '/'
  if (encodedPathSegments.some(segment => segment.length === 0)) return null

  const decodedPathSegments: string[] = []
  for (const segment of encodedPathSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      decoded.length === 0 ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return null
    }
    decodedPathSegments.push(decoded)
  }
  try {
    return `/${normalizeBrowserFilePath(decodedPathSegments.join('/'))}`
  } catch {
    return null
  }
}

function driveFilesUrl(workspaceSlug: string, browserPath: string, allowRoot: boolean): string {
  if (!browserPath.startsWith('/')) throw new Error('A browser path must start with /')
  const normalized = normalizeBrowserFilePath(browserPath, allowRoot)
  const root = `${workspaceRoot(workspaceSlug)}/files`
  return normalized.length === 0 ? root : `${root}/${encodeBrowserFilePath(normalized)}`
}

export const driveRoutes = {
  /* The drive's map of itself — and the only agents home there is. The shape of
     every map URL belongs to `agents-map-url`, so this is a name for one place
     on it rather than a second opinion about how it is spelled. */
  /* The Agents tab lands on the root agent's conversation, spelled through the
     grammar rather than as a literal. Pointing it at the bare path would make
     every tab click pay a mount and a redirect. */
  agents: (workspaceSlug: string) =>
    agentsMapUrl(workspaceSlug, {
      kind: 'agent',
      agentSlug: ROOT_AGENT_SCOPE,
      card: { kind: 'default' },
    }),
  graph: (workspaceSlug: string) => agentsMapUrl(workspaceSlug, { kind: 'graph' }),
  marketplace: (workspaceSlug: string) => `${workspaceRoot(workspaceSlug)}/agents/marketplace`,
  // Publisher-qualified: two publishers may list the same agent name, so the
  // name alone cannot address a listing.
  marketplaceListing: (workspaceSlug: string, publisherSlug: string, agentName: string) =>
    `${workspaceRoot(workspaceSlug)}/agents/marketplace/${encodeURIComponent(publisherSlug)}/${encodeURIComponent(agentName)}`,
  files: (workspaceSlug: string) => driveFolderUrl(workspaceSlug, '/'),
  desktop: (workspaceSlug: string) => `${workspaceRoot(workspaceSlug)}/desktop`,
  integrations: (workspaceSlug: string) => `${workspaceRoot(workspaceSlug)}/integrations`,
} as const satisfies Record<DriveTab, (workspaceSlug: string) => string> & {
  graph: (workspaceSlug: string) => string
  marketplace: (workspaceSlug: string) => string
  marketplaceListing: (workspaceSlug: string, publisherSlug: string, agentName: string) => string
}

/**
 * A drive path as a destination, degrading to the drive root.
 *
 * The server owns anchor and entry paths, and a malformed one must not turn a
 * click into an exception or let it escape the root. `folder` picks which of
 * the two grammars to use — a folder listing or an opened file.
 */
export function driveDestination(
  workspaceSlug: string,
  drivePath: string | undefined,
  kind: 'file' | 'folder' = 'file',
): string {
  if (drivePath === undefined) return driveRoutes.files(workspaceSlug)
  try {
    const browserPath = browserPathFromAnchorPath(drivePath)
    return kind === 'folder'
      ? driveFolderUrl(workspaceSlug, browserPath)
      : driveFileUrl(workspaceSlug, browserPath)
  } catch {
    return driveRoutes.files(workspaceSlug)
  }
}

/* ---- there is no workspace-level session or app address any more ----
   `sessionUrl`, `sessionsUrl`, `sessionsNewUrl` and `agentJobsUrl` all lived
   here and all named `/w/:ws/sessions…`. They are gone rather than repointed,
   because the thing they addressed does not exist at this level: a session is
   one agent's conversation and an app is one agent's app, so both are built by
   `agents-map-url` under the agent that owns them. A drive-wide list of either
   was a page with no owner, and the doors that led to it are gone too.

   Everything under the Agents tab that is *not* the map. The map itself is
   `isMapPath`, asked first in `driveTabForPath` — so this pattern never has to
   describe the canvas, and widening the canvas grammar cannot silently leave
   the tab dark. Train renders the agent roster rail, so every Train scope keeps
   the tab lit, including the canonical `/train` shape the legacy
   `/agents/:slug/train` URLs redirect into. */
const drivePathPatterns: ReadonlyArray<readonly [DriveTab, RegExp]> = [
  [
    'agents',
    /^\/w\/[^/]+\/(?:agents\/(?:marketplace(?:\/[^/]+\/[^/]+)?|[^/]+\/(?:settings|train(?:\/[^/]+)?))|train(?:\/[^/]+){0,2})\/?$/,
  ],
  ['files', /^\/w\/[^/]+\/files(?:\/.*)?\/?$/],
  ['desktop', /^\/w\/[^/]+\/desktop\/?$/],
  ['integrations', /^\/w\/[^/]+\/integrations\/?$/],
]

export function driveTabForPath(path: string): DriveTab | null {
  if (isMapPath(path)) return 'agents'
  const pathname = path.split(/[?#]/, 1)[0] ?? ''
  return drivePathPatterns.find(([, pattern]) => pattern.test(pathname))?.[0] ?? null
}

/**
 * Whether a path is the drive's canvas rather than one of its documents.
 *
 * The canvas is drawn edge to edge and the top bar is frosted glass over it, so
 * the shell hands it the whole window instead of the window minus a bar. A
 * document gets the ordinary treatment: it begins below the bar and slides
 * under it as you scroll.
 *
 * Map destinations share the edge-to-edge shell; the route grammar owns
 * that classification.
 */
export function isDriveCanvasPath(path: string): boolean {
  return isMapPath(path)
}

export function driveWorkspaceDestination(path: string, workspaceSlug: string): string {
  const tab = driveTabForPath(path) ?? 'agents'
  return driveRoutes[tab](workspaceSlug)
}
