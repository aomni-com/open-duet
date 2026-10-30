import { expect, test, type Page } from '@playwright/test'

import {
  FIXTURE_CACHE_DATABASE,
  RENAMED_FIRST_AGENT,
} from '../../components/playground/cache-continuity-fixture'
import { QUERY_CACHE_IDB } from '../../spa/api/idb-storage'
import { QUERY_CACHE_STORAGE_KEY } from '../../spa/api/query-persistence'

/* ============================================================================
   What a browser has already read, it does not read again — and does not lose.

   These take no pictures. They ask the one question the persisted query cache
   exists to answer: after a workspace has been read once, can the reader keep
   moving around it when the answers stop coming? A screenshot cannot tell you
   that, because the failure looks like a skeleton, and a skeleton is a picture
   the product draws on purpose.

   The measurement is the same in every test: `[data-loading-view]` is what
   every page-level wait in the product carries (see `spa/loading/README.md`),
   and `checkVisibility` with opacity is what separates one the reader is
   actually waiting behind from one dissolving away behind the thing that
   replaced it.
   ========================================================================= */

/** Which page-level waits the reader can actually see right now. */
async function visibleWaits(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-loading-view], [data-bootstrap-island]')]
      .filter(node =>
        (node as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      )
      .map(node => node.getAttribute('data-loading-view') ?? 'bootstrap-island'),
  )
}

/**
 * Which reads this browser has written down.
 *
 * Read from IndexedDB rather than inferred from the screen, because the two can
 * disagree in the direction that matters: a surface drawn from a cache still in
 * memory looks exactly like one drawn from a cache that survived.
 */
async function persistedReads(page: Page): Promise<string[]> {
  return await page.evaluate(
    async ({ database, cell, idb }) => {
      const open = indexedDB.open(database, idb.version)
      const connection = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onupgradeneeded = () => open.result.createObjectStore(idb.store)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      const stored = await new Promise<string | undefined>((resolve, reject) => {
        const request = connection
          .transaction(idb.store, 'readonly')
          .objectStore(idb.store)
          .get(cell)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (stored === undefined) return []
      const parsed = JSON.parse(stored) as { clientState: { queries: { queryHash: string }[] } }
      return parsed.clientState.queries.map(query => query.queryHash)
    },
    { database: FIXTURE_CACHE_DATABASE, cell: QUERY_CACHE_STORAGE_KEY, idb: QUERY_CACHE_IDB },
  )
}

async function land(page: Page, path: string, options: { apiDead?: boolean } = {}) {
  const dead = options.apiDead === true ? '&offline=1' : ''
  await page.goto(`/playground/cache-continuity?path=${encodeURIComponent(path)}${dead}`)
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 60_000 })
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const ring = (page: Page) => page.locator('[data-destination-content="agentPage"]')

const integrations = (page: Page) => page.locator('[data-destination-content="integrations"]')

/**
 * One pass over the destinations this fixture can actually answer for, so each
 * has been read once.
 *
 * Drive is not among them: its imperative directory cache has its own
 * continuity contract in `spa/files/lib/files-view.test.ts`, while this
 * journey is narrowly about the persisted react-query destinations.
 */
async function walkTheWorkspace(page: Page) {
  await land(page, '/w/acme/agents')
  await expect(ring(page)).toContainText('Research')
  await tab(page, 'Integrations').click()
  await expect(integrations(page)).toContainText('Gmail')
  await tab(page, 'Agents').click()
  await expect(ring(page)).toContainText('Research')
  /* The walk is only over once it is written down. Polling the store rather
     than sleeping past the persister's throttle: the throttle is an
     implementation detail and the store is the contract. */
  await expect
    .poll(async () => await persistedReads(page), { timeout: 20_000 })
    .toEqual(
      expect.arrayContaining([
        '["duet","workspaces","acme","agents","list"]',
        '["duet","workspaces","acme","integrations","connections"]',
      ]),
    )
}

test('a workspace read once opens again with nothing answering', async ({ page }) => {
  await walkTheWorkspace(page)

  await land(page, '/w/acme/agents', { apiDead: true })
  const map = ring(page)
  await expect(map).toContainText('Research')
  await expect(map).toContainText('Reviewer')
  // Not a frame with a skeleton in it — the workspace, drawn.
  expect(await visibleWaits(page)).toEqual([])

  // And the walk continues from there, still with nothing answering.
  await tab(page, 'Integrations').click()
  await expect(integrations(page)).toContainText('Gmail')
  expect(await visibleWaits(page)).toEqual([])
})

/* The control, and the reason the test above means anything. Same fixture,
   same dead API, same assertions available — but this browser was never told
   what is in the workspace, so it must not be able to draw one. Without this,
   a fixture quietly answering from memory would make the test above pass while
   the cache did nothing at all. */
test('a browser that has read nothing cannot draw a workspace it has never seen', async ({
  page,
}) => {
  await land(page, '/w/acme/agents', { apiDead: true })

  await expect(ring(page)).not.toContainText('Research')
  await expect(ring(page)).not.toContainText('Reviewer')
})

test('losing the network mid-sitting keeps every destination already read', async ({
  context,
  page,
}) => {
  await walkTheWorkspace(page)
  await context.setOffline(true)

  /* The complaint this whole change is about, with the network as the extreme
     case of a slow one: clicking between the bar's destinations must cost the
     reader no wait for anything they have already been shown. */
  await tab(page, 'Integrations').click()
  await expect(integrations(page)).toContainText('Gmail')
  expect(await visibleWaits(page)).toEqual([])

  await tab(page, 'Agents').click()
  await expect(ring(page)).toContainText('Research')
  expect(await visibleWaits(page)).toEqual([])
})

test('coming back catches up on what changed, without a skeleton in between', async ({
  context,
  page,
}) => {
  await land(page, '/w/acme/agents')
  await expect(ring(page)).toContainText('Research')

  await context.setOffline(true)
  // The workspace moves on while nobody is listening.
  await page
    .getByRole('button', { name: 'Rename the first agent', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  // Which the reader cannot know yet: what is on screen is what they last read.
  await expect(ring(page)).toContainText('Research')
  await expect(ring(page)).not.toContainText(RENAMED_FIRST_AGENT)

  await context.setOffline(false)
  await expect(ring(page)).toContainText(RENAMED_FIRST_AGENT, { timeout: 20_000 })
  /* The catch-up happened underneath the workspace rather than in front of it.
     A refetch that blanked the map back to its skeleton would be the same wait
     this change exists to remove, arriving one moment later. */
  expect(await visibleWaits(page)).toEqual([])
})
