import { type App } from '@repo/contract'

import { appDisplayName } from '../apps/app-icon'
import {
  appStatusPresentation,
  type AppDisplayStatus,
  type AppStatusPill,
} from '../status/entity-status'
import { anchorPathFromBrowserPath } from './lib/paths'
import type { DirectoryEntry } from './lib/types'

export type AppRowPresentation = {
  app: App
  displayName: string
  status: AppDisplayStatus
  pill?: AppStatusPill
  pillClass?: string
}

/**
 * A row in the drive is a filesystem entry, and an app is a decoration on the
 * folder it is anchored to.
 *
 * There used to be a second kind of row for apps whose folder had vanished,
 * because such an app was stranded forever with nothing to render it against.
 * It is not stranded any more: the anchor rail reaps a row whose folder stays
 * gone, so the listing and the app set converge on their own. The filesystem is
 * the source of truth, which means the listing is the row set.
 */
export type FilesRow = { entry: DirectoryEntry; app?: AppRowPresentation }

export function projectFilesRows({
  entries,
  apps,
}: {
  entries: readonly DirectoryEntry[]
  apps: readonly App[]
}): FilesRow[] {
  const appsByPath = new Map(apps.map(app => [app.anchorPath, presentApp(app)]))
  return entries.map(entry => {
    const app = entry.isDirectory
      ? appsByPath.get(anchorPathFromBrowserPath(entry.path))
      : undefined
    return app === undefined ? { entry } : { entry, app }
  })
}

function presentApp(app: App): AppRowPresentation {
  const presentation = appStatusPresentation(app)
  return {
    app,
    displayName: appDisplayName(app),
    status: presentation.status,
    ...(presentation.pill === undefined
      ? {}
      : { pill: presentation.pill, pillClass: presentation.pillClass }),
  }
}
