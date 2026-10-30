import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { agentSettingsUrl } from './agents-map-url'
import {
  driveFileUrl,
  driveFolderUrl,
  driveRoutes,
  driveTabForPath,
  driveWorkspaceDestination,
  filesBrowserPathFromPathname,
  isDriveCanvasPath,
} from './drive-routes'

const WEB_ROOT = path.resolve(import.meta.dir, '../..')

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (
        ['node_modules', '.next', '.turbo', 'tests', 'playground', '__fixtures__'].includes(
          entry.name,
        )
      )
        return []
      return productionTypeScriptFiles(absolutePath)
    }
    if (
      !entry.isFile() ||
      !/\.tsx?$/.test(entry.name) ||
      /\.(?:test|fixture)\.tsx?$/.test(entry.name) ||
      /^fixtures?\.tsx?$/.test(entry.name)
    )
      return []
    return [absolutePath]
  })
}

describe('Drive route contract', () => {
  test('builds encoded folder URLs and preserves the bare files route', () => {
    expect(driveFolderUrl('acme space', '/Q3 Reports/Drafts')).toBe(
      '/w/acme%20space/files/Q3%20Reports/Drafts',
    )
    expect(driveFolderUrl('acme space', '/')).toBe(driveRoutes.files('acme space'))
  })

  test('builds file URLs with the shared grammar and rejects the root', () => {
    expect(driveFileUrl('acme', '/reports/100%.pdf')).toBe('/w/acme/files/reports/100%25.pdf')
    expect(() => driveFileUrl('acme', '/')).toThrow('A file path is required')
  })

  test('rejects malformed and out-of-space files pathnames', () => {
    const malformed = [
      '/w/acme/files/%GG',
      '/w/%GG/files/report.txt',
      '/w//files/report.txt',
      '/w/acme/files/..',
      '/w/acme/files/%2E',
      '/w/acme/files/.duet',
      '/w/acme/files/reports//weekly',
      '/w/other/files/report.txt',
      '/w/acme/computer/jobs/report.txt',
      '/w/acme/files/a%2Fb',
    ]

    for (const pathname of malformed) {
      expect(filesBrowserPathFromPathname(pathname, 'acme'), pathname).toBeNull()
    }
  })

  test('normalizes trailing slash variants without requiring a redirect', () => {
    expect(filesBrowserPathFromPathname('/w/acme/files', 'acme')).toBe('/')
    expect(filesBrowserPathFromPathname('/w/acme/files///', 'acme')).toBe('/')
    expect(filesBrowserPathFromPathname('/w/acme/files/reports///', 'acme')).toBe('/reports')
  })

  test('keeps files URL construction inside the grammar owner', () => {
    const exemptFiles = new Set([
      path.join(WEB_ROOT, 'spa/drive/drive-routes.ts'),
      path.join(WEB_ROOT, 'spa/routes/product-destinations.ts'),
    ])
    const offenders = productionTypeScriptFiles(WEB_ROOT)
      .filter(file => !exemptFiles.has(file))
      /* A *workspace-rooted* files path, not the bare word: `/files` alone now
         matches every `../files/...` import in the app. What this guards is one
         module minting the URL, so the marker is the shape only a URL has. */
      .filter(file => /\/w\/[^'"`\n]*\/files/.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(WEB_ROOT, file))

    expect(offenders).toEqual([])
  })

  test('makes the Agents home the canonical catalog destination', () => {
    expect(driveRoutes.agents('acme space')).toBe('/w/acme%20space/agents/root')
    // Publisher-qualified: two publishers may list the same agent name.
    expect(driveRoutes.marketplaceListing('acme space', 'acme labs', 'brief writer')).toBe(
      '/w/acme%20space/agents/marketplace/acme%20labs/brief%20writer',
    )
    expect(driveTabForPath('/w/acme/agents/root')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/marketplace/acme-labs/research')).toBe('agents')
    expect(driveWorkspaceDestination('/w/acme/marketplace/research', 'second-workspace')).toBe(
      '/w/second-workspace/agents/root',
    )
  })

  /* The slug comes straight out of the map's `onOpen`, so the encoding is the
     contract — an agent named with a space or a slash must not be able to
     reshape the URL. The session and job builders that used to sit beside this
     are gone with the workspace-level addresses they named; every session and
     every app is built by `agents-map-url` under the agent that owns it. */
  test('the destinations the map opens encode everything they interpolate', () => {
    expect(agentSettingsUrl('acme space', 'brief writer')).toBe(
      '/w/acme%20space/agents/brief%20writer/settings',
    )
  })

  test('the map is the Agents tab, and the agent surfaces beside it are too', () => {
    expect(driveRoutes.agents('acme space')).toBe('/w/acme%20space/agents/root')
    expect(driveTabForPath('/w/acme/agents/root')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/')).toBe('agents')
    // reached from the map, but it is an agent's own document
    expect(driveTabForPath('/w/acme/agents/research/settings')).toBe('agents')
    // and switching workspaces keeps you on the same pillar
    expect(driveWorkspaceDestination('/w/acme/agents/root', 'labs')).toBe('/w/labs/agents/root')
  })

  /* A shape the grammar does not have lights nothing. `agents/:slug/chat` was
     an alternative in this pattern that no route ever mounted — the tab lit for
     a path that renders the not-found surface. */
  test('a path under an agent that no route mounts lights no tab', () => {
    expect(driveTabForPath('/w/acme/agents/research/chat')).toBe(null)
  })

  /* The bar is frosted glass, so what sits under it matters: the map runs the
     whole window and shows through, every document begins below it.

     An unfolded agent is the map — the camera has flown into a face that is
     still standing on the canvas — and so is the dialog drawn over it. That was
     always true; it only becomes assertable now that those states have URLs to
     ask about. */
  test('names the map, and only the map, as the surface the bar floats over', () => {
    expect(isDriveCanvasPath('/w/acme/agents/root')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/')).toBe(true)
    expect(isDriveCanvasPath('/w/acme%20space/agents/root')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents?view=list')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/research')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/research/files/agents/research')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/research/files')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/research/apps/invoices')).toBe(true)
    expect(isDriveCanvasPath('/w/acme/agents/research/sessions/session_1')).toBe(true)
    // documents reached from the map are still documents
    expect(isDriveCanvasPath('/w/acme/agents/research/settings')).toBe(false)
    expect(isDriveCanvasPath('/w/acme/agents/research/train')).toBe(false)
    expect(isDriveCanvasPath('/w/acme/agents/marketplace')).toBe(false)
    expect(isDriveCanvasPath('/w/acme/sessions/session_1')).toBe(false)
    expect(isDriveCanvasPath('/w/acme/files')).toBe(false)
    expect(isDriveCanvasPath('/w/acme/sessions')).toBe(false)
  })

  test('builds the workspace pillar routes from one owner', () => {
    expect(driveRoutes.agents('acme')).toBe('/w/acme/agents/root')
    expect(driveRoutes.files('acme')).toBe('/w/acme/files')
    expect(driveRoutes.integrations('acme')).toBe('/w/acme/integrations')
  })

  test('maps only live product URLs into the top bar', () => {
    // Every surface an agent has keeps the Agents tab lit — the map's own
    // shapes, the agent's document, and the legacy Train redirect alike.
    expect(driveTabForPath('/w/acme/agents/research')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/files/agents/research')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/files')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/apps/invoices')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/sessions')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/sessions/session_1')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/settings')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/marketplace')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/train')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/research/train/support-handbook')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/root')).toBe('agents')
    expect(driveTabForPath('/w/acme/agents/marketplace/acme-labs/research')).toBe('agents')
    expect(driveTabForPath('/w/acme/files?shareRequest=share_1')).toBe('files')
    expect(driveTabForPath('/w/acme/files/reports/weekly')).toBe('files')
    // Train is an agent surface: it renders the agent roster rail, so the Agents
    // tab stays lit at every scope rather than the top bar going blank.
    expect(driveTabForPath('/w/acme/train')).toBe('agents')
    // Every Train scope is a named row now, the drive's own included.
    expect(driveTabForPath('/w/acme/train/root')).toBe('agents')
    expect(driveTabForPath('/w/acme/train/research')).toBe('agents')
    expect(driveTabForPath('/w/acme/train/root/support-handbook')).toBe('agents')
    expect(driveTabForPath('/w/acme/train/research/brief-format')).toBe('agents')
    expect(driveTabForPath('/w/acme/integrations')).toBe('integrations')
    expect(driveTabForPath('/w/acme/settings/general')).toBeNull()
    expect(driveTabForPath('/w/acme/drive/agents')).toBeNull()
  })

  test('keeps the pillar but drops route detail on workspace switch', () => {
    expect(driveWorkspaceDestination('/w/acme/marketplace/research', 'second-workspace')).toBe(
      '/w/second-workspace/agents/root',
    )
    expect(
      driveWorkspaceDestination('/w/acme/files?shareRequest=share_1', 'second-workspace'),
    ).toBe('/w/second-workspace/files')
  })
})
