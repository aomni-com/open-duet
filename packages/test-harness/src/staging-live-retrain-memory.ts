import assert from 'node:assert/strict'

import {
  TrainRecordListResponseSchema,
  TrainRecordResponseSchema,
  TrainRestageResponseSchema,
  TrainStartResponseSchema,
  TrainUploadSessionSchema,
  TrainUploadsListResponseSchema,
  urlToUploadFilename,
  vmUploadUrl,
  type TrainRecord,
} from '@repo/contract'

import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { waitForTrain } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

/**
 * A real page and a real file, so the run exercises both halves of a corpus:
 * the file replays from the archive, and the URL is re-scraped through
 * Firecrawl on retrain.
 */
const SOURCE_URL = 'https://example.com/'
const SOURCE_FILENAME = 'operating-notes.md'
const FIRST_CORPUS = [
  '# Operating notes',
  '',
  'The internal escalation codename is violet kestrel.',
  'Renewals are reviewed on the second Tuesday of each month.',
].join('\n')
const SECOND_CORPUS = [
  '# Operating notes',
  '',
  'The internal escalation codename is amber gannet.',
  'Renewals moved to the final Thursday of each month.',
].join('\n')

export interface RetrainMemoryEvidence {
  recordSlug: string
  firstJobId: string
  secondJobId: string
  restaged: number
  rescraped: number
  fellBack: string[]
  recordCountAfterRetrain: number
  firstCompletionReportLagMs: number
  secondCompletionReportLagMs: number
}

export async function runRetrainMemoryJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<RetrainMemoryEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'retrain-memory',
    label: 'Retrain a trained memory',
    onProgress: options.onProgress,
    run: async context => await runRetrainMemoryAcceptance(context),
  })
}

/**
 * Train a memory, retrain it, and prove there is still exactly one.
 *
 * Everything before the final count is setup. The assertion that matters is
 * that a retrain *replaced* a memory rather than adding a second one beside
 * it — the failure this whole feature is built to avoid, and one that no unit
 * test can see because it depends on the gateway resolving a target slug
 * against a real store.
 */
async function runRetrainMemoryAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<RetrainMemoryEvidence> {
  const { env, workspace, apiToken, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  const before = TrainRecordListResponseSchema.parse(
    await apiJson(`${base}/train/records`, { headers: bearer(apiToken) }, 200, 'record baseline'),
  )
  const baselineSlugs = new Set(before.items.map(record => record.slug))

  await stageCorpus(base, apiToken, FIRST_CORPUS)
  progress('firstCorpusStaged')

  const firstJob = TrainStartResponseSchema.parse(
    await apiJson(
      `${base}/train`,
      { method: 'POST', headers: bearerJson(apiToken), body: '{}' },
      202,
      'first training',
    ),
  )
  const firstStatus = await waitForTrain(env.apiUrl, workspace.slug, firstJob.jobId, apiToken, {
    maxReportDelayMs: 15_000,
  })
  progress('firstTrainingComplete')

  const trained = await newestRecord(base, apiToken, baselineSlugs)
  assert.equal(trained.hasArchive, true, 'a fresh training must keep its archive')
  assert.ok(
    (trained.sources ?? []).some(source => source.url === SOURCE_URL),
    'the scraped page must be listed as a source, identified by its URL',
  )
  assert.ok(
    (trained.sources ?? []).some(source => source.relPath === SOURCE_FILENAME),
    'the uploaded file must be listed as a source',
  )

  // The archived copy is readable, which is what makes the sources clickable.
  const archived = await apiText(
    `${base}/train/records/${encodeURIComponent(trained.slug)}/sources/${SOURCE_FILENAME}`,
    { headers: bearer(apiToken) },
    200,
    'archived source read',
  )
  assert.ok(archived.includes('violet kestrel'), 'the archive holds the original bytes')
  progress('archiveReadable')

  // Change the file so a successful retrain is visible in the memory itself
  // rather than only in a record count.
  const restaged = TrainRestageResponseSchema.parse(
    await apiJson(
      `${base}/train/records/${encodeURIComponent(trained.slug)}/restage`,
      { method: 'POST', headers: bearerJson(apiToken), body: '{}' },
      200,
      'restage',
    ),
  )
  assert.ok(restaged.staged >= 2, 'restage puts the whole archive back in the inbox')
  progress('restaged')

  const inbox = TrainUploadsListResponseSchema.parse(
    await apiJson(
      `${base}/train/uploads`,
      { headers: bearer(apiToken) },
      200,
      'inbox after restage',
    ),
  )
  assert.ok(
    inbox.items.some(file => file.filename === urlToUploadFilename(SOURCE_URL)),
    'the scraped page comes back as a URL entry, not an anonymous markdown file',
  )
  assert.ok(
    inbox.items.some(file => file.filename === SOURCE_FILENAME),
    'the uploaded file comes back under its own name',
  )

  await putUpload(base, apiToken, SOURCE_FILENAME, SECOND_CORPUS)
  const secondJob = TrainStartResponseSchema.parse(
    await apiJson(
      `${base}/train`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ targetSlug: trained.slug }),
      },
      202,
      'retraining',
    ),
  )
  const secondStatus = await waitForTrain(env.apiUrl, workspace.slug, secondJob.jobId, apiToken, {
    maxReportDelayMs: 15_000,
  })
  progress('retrainComplete')

  const after = TrainRecordListResponseSchema.parse(
    await apiJson(`${base}/train/records`, { headers: bearer(apiToken) }, 200, 'records after'),
  )
  const produced = after.items.filter(record => !baselineSlugs.has(record.slug))

  // The whole point. A retrain that quietly minted a second memory would pass
  // every other assertion in this file.
  assert.equal(produced.length, 1, 'retraining replaces the memory instead of adding one')
  assert.equal(produced[0]?.slug, trained.slug, 'the memory keeps the slug it was trained under')

  const reread = TrainRecordResponseSchema.parse(
    await apiJson(
      `${base}/train/records/${encodeURIComponent(trained.slug)}`,
      { headers: bearer(apiToken) },
      200,
      'retrained record',
    ),
  )
  assert.ok(
    reread.record.content.length > 0 && reread.record.hasArchive,
    'the retrained memory has content and a fresh archive',
  )

  // Synthesis is instructed to write markdown, and the page renders it as
  // markdown. Deliberately lenient about WHICH structure appears: the corpus
  // has an enumeration and a heading-worthy split, so a model following the
  // instruction produces some of `##`, a bullet, or a table — but which one is
  // the model's choice, and pinning a specific shape would make a live journey
  // fail on a reasonable rewording.
  const structure = /^##\s|\n##\s|\n[-*]\s|\n\|/.test(reread.record.content)
  assert.ok(
    structure,
    `the memory is markdown, not a prose blob: ${JSON.stringify(reread.record.content.slice(0, 200))}`,
  )

  return {
    recordSlug: trained.slug,
    firstJobId: firstJob.jobId,
    firstCompletionReportLagMs: firstStatus.completionReportLagMs,
    secondCompletionReportLagMs: secondStatus.completionReportLagMs,
    secondJobId: secondJob.jobId,
    restaged: restaged.staged,
    rescraped: restaged.rescraped,
    fellBack: restaged.fellBack,
    recordCountAfterRetrain: produced.length,
  }
}

async function stageCorpus(base: string, apiToken: string, body: string): Promise<void> {
  await apiJson(
    `${base}/train/uploads/url`,
    { method: 'POST', headers: bearerJson(apiToken), body: JSON.stringify({ url: SOURCE_URL }) },
    201,
    'stage scraped page',
  )
  await putUpload(base, apiToken, SOURCE_FILENAME, body)
}

/**
 * Stage one file the way the product does.
 *
 * There is no file-upload route on the API: a browser cannot send credentials
 * through a CORS preflight, so the API mints a short-lived grant and the bytes
 * go straight to the VM. A journey that PUT to the API would be testing a route
 * that does not exist — which is exactly what the first live run found.
 */
async function putUpload(
  base: string,
  apiToken: string,
  filename: string,
  body: string,
): Promise<void> {
  const grant = TrainUploadSessionSchema.parse(
    await apiJson(
      `${base}/train/uploads/session`,
      { method: 'POST', headers: bearerJson(apiToken), body: '{}' },
      200,
      `upload session for ${filename}`,
    ),
  )
  const response = await stagingFetch(vmUploadUrl(grant, filename), {
    method: 'PUT',
    headers: { authorization: `Bearer ${grant.uploadToken}`, 'content-type': 'text/markdown' },
    body,
  })
  assert.equal(response.status, 201, `stage ${filename}: ${response.status}`)
}

/** The one record this run created, waited for rather than assumed. */
async function newestRecord(
  base: string,
  apiToken: string,
  baselineSlugs: ReadonlySet<string>,
): Promise<TrainRecord> {
  const list = TrainRecordListResponseSchema.parse(
    await apiJson(
      `${base}/train/records`,
      { headers: bearer(apiToken) },
      200,
      'records after train',
    ),
  )
  const created = list.items.filter(record => !baselineSlugs.has(record.slug))
  assert.equal(created.length, 1, 'one training produces exactly one memory')
  const slug = created[0]!.slug
  const detail = TrainRecordResponseSchema.parse(
    await apiJson(
      `${base}/train/records/${encodeURIComponent(slug)}`,
      { headers: bearer(apiToken) },
      200,
      'trained record detail',
    ),
  )
  return detail.record
}
