import { createReadStream } from 'node:fs'
import { basename } from 'node:path'

import type { FetchLike, TrainJobStatus, TrainUploadSession } from '@repo/contract'

import type { CliIo } from './cli-support.js'
import { CliError, EXIT_CODES, usageError } from './exit-codes.js'
import { throwHttpError, type ApiClient } from './http.js'

interface TrainContext {
  global: { json: boolean }
  api: ApiClient
  io: CliIo
  sleep: (ms: number) => Promise<void>
  fetch: FetchLike
  now?: () => number
}

interface TrainJobResponse {
  jobId?: string
  job?: CliTrainJob
}

interface TrainStatusResponse {
  job?: CliTrainJob
}

type CliTrainJob = Pick<TrainJobStatus, 'jobId' | 'state' | 'phase' | 'error'>

const DEFAULT_TRAIN_WAIT_TIMEOUT_MS = 60 * 60 * 1000

export async function train(args: string[], ctx: TrainContext): Promise<void> {
  const options = parseTrainOptions(args)
  if (options.files.length > 0) {
    const sessionResponse = await ctx.api.request(
      `/ws/${encodeURIComponent(options.workspaceSlug)}/train/uploads/session`,
      { method: 'POST' },
    )
    const session = (await sessionResponse.json()) as Partial<TrainUploadSession>
    if (typeof session.vmBaseUrl !== 'string' || typeof session.uploadToken !== 'string') {
      throw new CliError(
        'invalid_response',
        'Train upload session response was malformed.',
        EXIT_CODES.generic,
      )
    }
    for (const file of options.files) {
      const filename = basename(file)
      const uploadUrl = new URL(
        `v1/train/uploads/${encodeURIComponent(filename)}`,
        ensureTrailingSlash(session.vmBaseUrl),
      )
      const upload = await ctx.fetch(uploadUrl, {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.uploadToken}` },
        body: createReadStream(file) as unknown as RequestInit['body'],
        duplex: 'half',
      } as RequestInit)
      if (!upload.ok) await throwHttpError(upload)
    }
  }
  for (const url of options.urls) {
    await ctx.api.request(`/ws/${encodeURIComponent(options.workspaceSlug)}/train/uploads/url`, {
      method: 'POST',
      json: { url },
    })
  }
  const start = await ctx.api.request(`/ws/${encodeURIComponent(options.workspaceSlug)}/train`, {
    method: 'POST',
  })
  const started = (await start.json()) as TrainJobResponse
  if (typeof started.jobId !== 'string') {
    throw new CliError('invalid_response', 'Train response was malformed.', EXIT_CODES.generic)
  }
  if (!ctx.global.json) {
    writeText(ctx.io.stdout, `Started train job ${started.jobId}\n`)
    writeText(ctx.io.stdout, 'The job continues server-side if this CLI exits.\n')
  }

  const now = ctx.now ?? Date.now
  const deadline = now() + options.waitTimeoutMs
  while (true) {
    if (now() >= deadline) {
      throw new CliError(
        'train_timeout',
        `Timed out waiting for train job ${started.jobId}; it continues server-side.`,
        EXIT_CODES.generic,
      )
    }
    const statusResponse = await ctx.api.request(
      `/ws/${encodeURIComponent(options.workspaceSlug)}/train/${encodeURIComponent(started.jobId)}`,
    )
    const status = (await statusResponse.json()) as TrainStatusResponse
    if (status.job === undefined) {
      throw new CliError(
        'invalid_response',
        'Train status response was malformed.',
        EXIT_CODES.generic,
      )
    }
    if (status.job.state === 'done') {
      if (ctx.global.json) writeJson(ctx.io.stdout, { job: status.job })
      else writeText(ctx.io.stdout, `Train job ${status.job.jobId} completed\n`)
      return
    }
    if (status.job.state === 'failed') {
      throw new CliError(
        'train_failed',
        status.job.error ?? 'Train job failed.',
        EXIT_CODES.generic,
      )
    }
    if (!ctx.global.json) {
      writeText(ctx.io.stdout, `Train job ${status.job.jobId}: ${status.job.phase}\n`)
    }
    if (now() + 1_000 > deadline) {
      throw new CliError(
        'train_timeout',
        `Timed out waiting for train job ${started.jobId}; it continues server-side.`,
        EXIT_CODES.generic,
      )
    }
    await ctx.sleep(1_000)
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function parseTrainOptions(args: string[]): {
  workspaceSlug: string
  urls: string[]
  files: string[]
  waitTimeoutMs: number
} {
  if (args.length === 0) throw usageError(trainUsage())
  const [workspaceSlug, ...rest] = args
  const urls: string[] = []
  const files: string[] = []
  let waitTimeoutMs = DEFAULT_TRAIN_WAIT_TIMEOUT_MS
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!
    if (arg !== '--url' && arg !== '--file' && arg !== '--wait-timeout') {
      throw usageError(`Unknown option: ${arg}`)
    }
    const value = rest[index + 1]
    if (value === undefined) throw usageError(`${arg} requires a value`)
    if (arg === '--url') urls.push(value)
    else if (arg === '--file') files.push(value)
    else {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw usageError('--wait-timeout must be a positive number of seconds')
      }
      waitTimeoutMs = seconds * 1_000
    }
    index += 1
  }
  if (urls.length + files.length === 0) {
    throw usageError(trainUsage())
  }
  return { workspaceSlug: workspaceSlug!, urls, files, waitTimeoutMs }
}

function trainUsage(): string {
  return 'Usage: train <workspace> --url <url> [--file <path>] [--wait-timeout <seconds>]'
}

function writeJson(sink: CliIo['stdout'], value: unknown): void {
  writeText(sink, `${JSON.stringify(value)}\n`)
}

function writeText(sink: CliIo['stdout'], text: string): void {
  sink.write(text)
}
