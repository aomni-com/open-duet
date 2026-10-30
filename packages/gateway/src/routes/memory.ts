import { Hono } from 'hono'

import {
  DEFAULT_MEMORY_LOCK_WAIT_MS,
  MEMORY_CLI_CONTRACT,
  MemoryAddRequestSchema,
  MemoryRecordSchema,
  MemorySearchResultSchema,
} from '@repo/contract'

import { settledDuetCli, spawnDuetCli, type DuetCliResult, type DuetCliRunner } from '../duet-cli'
import { classifyDuetCliFailure } from '../duet-cli-failure'

export interface MemoryRouteOptions {
  dbPath: string
  runner?: DuetCliRunner
  waitMs?: number
}

export function createMemoryRoutes(options: MemoryRouteOptions): Hono {
  const app = new Hono()
  const runner = settledDuetCli(options.runner ?? spawnDuetCli)
  const waitMs = options.waitMs ?? DEFAULT_MEMORY_LOCK_WAIT_MS

  app.post('/', async c => {
    const body = await readMemoryAddBody(c.req.raw)
    if (body === null) return c.json({ error: 'invalid_request' }, 400)

    const result = await runner(
      MEMORY_CLI_CONTRACT.add.argv({
        dbPath: options.dbPath,
        content: body.content,
        source: body.source,
        sessionId: body.sessionId,
        waitMs,
      }),
    )
    if (result.exitCode !== MEMORY_CLI_CONTRACT.exitCodes.ok) return cliFailureResponse(result)
    const parsed = parseJsonResult(result.stdout, MemoryRecordSchema)
    if (parsed === null) return c.json({ error: 'memory_cli_invalid_json' }, 502)
    return c.json(parsed)
  })

  app.get('/search', async c => {
    const query = c.req.query('q')?.trim() ?? ''
    if (query.length === 0 || query.includes('\0')) return c.json({ error: 'invalid_request' }, 400)
    const limit = parseLimit(c.req.query('limit'))
    if (limit === null) return c.json({ error: 'invalid_request' }, 400)

    const result = await runner(
      MEMORY_CLI_CONTRACT.recall.argv({
        dbPath: options.dbPath,
        query,
        limit,
        waitMs,
      }),
    )
    if (result.exitCode !== MEMORY_CLI_CONTRACT.exitCodes.ok) return cliFailureResponse(result)
    const records = parseJsonResult(result.stdout, MemorySearchResultSchema.shape.results)
    if (records === null) return c.json({ error: 'memory_cli_invalid_json' }, 502)
    const parsed = MemorySearchResultSchema.parse({ query, limit, results: records })
    return c.json(parsed)
  })

  return app
}

async function readMemoryAddBody(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  const parsed = MemoryAddRequestSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}

function parseJsonResult<T>(
  stdout: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    const result = schema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 10
  if (!/^\d+$/.test(raw)) return null
  const limit = Number(raw)
  return limit >= 1 && limit <= 100 ? limit : null
}

function cliFailureResponse(result: DuetCliResult): Response {
  // A killed command has no exit code worth classifying — it never got to say
  // what went wrong, so the honest answer is "the VM did not answer in time".
  if (result.timedOut === true) {
    return Response.json({ error: 'memory_cli_timeout' }, { status: 504 })
  }
  const failure = classifyDuetCliFailure(result.exitCode, result.stderr)
  if (failure.kind === 'lock_timeout') {
    return Response.json(
      { error: 'memory_lock_timeout', message: failure.message },
      { status: failure.status },
    )
  }
  // Add/recall do not look up a route resource; "not found" can describe the CLI binary itself.
  return Response.json(
    { error: 'memory_cli_failed', exitCode: result.exitCode, message: failure.message },
    { status: 502 },
  )
}
