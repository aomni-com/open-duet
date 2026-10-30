import { z } from 'zod'

import {
  DomainDnsConflictSchema,
  DomainDnsRecordSchema,
  DomainObservationSchema,
  type DomainObservation,
  type DomainTarget,
} from '@repo/contract'

export type VercelDomainErrorCode =
  | 'not_configured'
  | 'not_found'
  | 'target_mismatch'
  | 'provider_error'
  | 'invalid_response'
  | 'timeout'
  | 'response_too_large'
  | 'transport_error'

export class VercelDomainError extends Error {
  override name = 'VercelDomainError'
  constructor(
    readonly code: VercelDomainErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message)
  }
}

export type VercelDomainOptions = {
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
  token?: string
  deadlineMs?: number
}

const AssignmentSchema = z.object({
  name: z.string().max(253),
  apexName: z.string().min(1).max(253),
  projectId: z.string().min(1).max(256),
  gitBranch: z.string().max(255).nullable().optional(),
  verified: z.boolean(),
  verification: z.array(DomainDnsRecordSchema).max(32).optional(),
})
const ConfigSchema = z.object({
  misconfigured: z.boolean(),
  conflicts: z.array(DomainDnsConflictSchema).max(32).optional(),
  recommendedCNAME: z
    .array(z.object({ rank: z.number().finite(), value: z.string().min(1).max(4_096) }))
    .max(32)
    .optional(),
  recommendedIPv4: z
    .array(
      z.object({ rank: z.number().finite(), value: z.array(z.string().min(1).max(4_096)).max(32) }),
    )
    .max(32)
    .optional(),
})

type ProviderRequest = (
  path: string,
  init?: RequestInit,
) => Promise<{ status: number; body: unknown }>

async function operation<T>(
  target: DomainTarget,
  options: VercelDomainOptions,
  run: (request: ProviderRequest) => Promise<T>,
): Promise<T> {
  const token = options.token ?? process.env.DUET_VERCEL_DOMAINS_TOKEN
  if (!token) throw new VercelDomainError('not_configured', 'DUET_VERCEL_DOMAINS_TOKEN is not set')
  const controller = new AbortController()
  let rejectDeadline!: (error: Error) => void
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  const timer = setTimeout(
    () => {
      rejectDeadline(new VercelDomainError('timeout', 'Vercel domain operation timed out', true))
      controller.abort()
    },
    Math.min(30_000, Math.max(1, options.deadlineMs ?? 30_000)),
  )
  try {
    return await run(async (path, init) => {
      const url = new URL(path, 'https://api.vercel.com')
      url.searchParams.set('teamId', target.teamId)
      try {
        const response = await Promise.race([
          (options.fetch ?? fetch)(url, {
            ...init,
            signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }),
          deadline,
        ])
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (reader) {
            const chunk = await Promise.race([reader.read(), deadline])
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 256 * 1_024) {
              throw new VercelDomainError(
                'response_too_large',
                'Vercel domain response exceeds 256 KiB',
              )
            }
            chunks.push(chunk.value)
          }
        } catch (error) {
          // Abort does not guarantee a provider's stream has closed.
          void reader?.cancel().catch(() => {})
          throw error
        } finally {
          reader?.releaseLock()
        }
        const body = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
        }
        const text = new TextDecoder().decode(body)
        let parsed: unknown
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          parsed = text
        }
        return { status: response.status, body: parsed }
      } catch (error) {
        if (error instanceof VercelDomainError) throw error
        throw new VercelDomainError('transport_error', 'Vercel domain transport failed', true)
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

function providerError(status: number): never {
  throw new VercelDomainError(
    'provider_error',
    `Vercel domain request failed (${status})`,
    status === 429 || status >= 500,
    status,
  )
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new VercelDomainError('invalid_response', 'Vercel domain response is invalid')
  return parsed.data
}

async function inspectAssignment(
  hostname: string,
  target: DomainTarget,
  body: unknown,
  request: ProviderRequest,
  pointRead = false,
): Promise<z.infer<typeof AssignmentSchema>> {
  const supplied = parse(AssignmentSchema.partial({ apexName: true, projectId: true }), body)
  if (
    supplied.name !== hostname ||
    (supplied.projectId !== undefined && supplied.projectId !== target.projectId) ||
    (supplied.gitBranch !== undefined && supplied.gitBranch !== target.gitBranch)
  ) {
    throw new VercelDomainError(
      'target_mismatch',
      'Vercel domain belongs to a different project or branch',
    )
  }
  if (
    !supplied.projectId ||
    !supplied.apexName ||
    (!pointRead && supplied.gitBranch === undefined)
  ) {
    const inspected = await request(
      `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(hostname)}`,
    )
    if (inspected.status === 404)
      throw new VercelDomainError('not_found', 'Vercel domain assignment is missing', false, 404)
    if (inspected.status < 200 || inspected.status >= 300) providerError(inspected.status)
    body = inspected.body
  }
  // The point GET represents production by an omitted/null branch. POST bodies
  // with omitted branch metadata must reach that authoritative read first.
  const assignment = parse(AssignmentSchema, body)
  if (
    assignment.name !== hostname ||
    assignment.projectId !== target.projectId ||
    (assignment.gitBranch ?? null) !== target.gitBranch
  ) {
    throw new VercelDomainError(
      'target_mismatch',
      'Vercel domain belongs to a different project or branch',
    )
  }
  return assignment
}

async function observation(
  hostname: string,
  target: DomainTarget,
  body: unknown,
  request: ProviderRequest,
  pointRead = false,
): Promise<DomainObservation> {
  const assignment = await inspectAssignment(hostname, target, body, request, pointRead)
  const response = await request(`/v6/domains/${encodeURIComponent(hostname)}/config`)
  if (response.status < 200 || response.status >= 300) providerError(response.status)
  const config = parse(ConfigSchema, response.body)
  const records = [...(assignment.verification ?? [])]
  if (config.misconfigured) {
    const cname = [...(config.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]
    const ipv4 = [...(config.recommendedIPv4 ?? [])].sort((a, b) => a.rank - b.rank)[0]
    if (hostname !== assignment.apexName && cname)
      records.push({ type: 'CNAME', domain: hostname, value: cname.value.replace(/\.$/, '') })
    else if (ipv4)
      records.push(...ipv4.value.map(value => ({ type: 'A', domain: hostname, value })))
  }
  return parse(DomainObservationSchema, {
    hostname,
    apexName: assignment.apexName,
    ownershipVerified: assignment.verified,
    misconfigured: config.misconfigured,
    records,
    conflicts: config.conflicts ?? [],
    target: { projectId: assignment.projectId, gitBranch: assignment.gitBranch ?? null },
  })
}

export function addDomain(
  hostname: string,
  target: DomainTarget,
  options: VercelDomainOptions = {},
): Promise<DomainObservation> {
  return operation(target, options, async request => {
    const response = await request(
      `/v10/projects/${encodeURIComponent(target.projectId)}/domains`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: hostname,
          ...(target.gitBranch === null ? {} : { gitBranch: target.gitBranch }),
        }),
      },
    )
    if (response.status < 200 || response.status >= 300) {
      const error = z
        .object({ error: z.object({ code: z.enum(['domain_already_in_use', 'not_modified']) }) })
        .safeParse(response.body)
      if ((response.status === 400 || response.status === 409) && error.success) {
        const current = await request(
          `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(hostname)}`,
        )
        if (current.status === 404 && error.data.error.code === 'domain_already_in_use')
          throw new VercelDomainError(
            'target_mismatch',
            'This domain is already assigned to another Vercel project. Remove that assignment or contact support, then recheck.',
            false,
            response.status,
          )
        if (current.status === 404)
          throw new VercelDomainError(
            'not_found',
            'Vercel domain assignment is missing',
            false,
            404,
          )
        if (current.status < 200 || current.status >= 300) providerError(current.status)
        return observation(hostname, target, current.body, request, true)
      }
      providerError(response.status)
    }
    return observation(hostname, target, response.body, request)
  })
}

export function readDomain(
  hostname: string,
  target: DomainTarget,
  options: VercelDomainOptions = {},
): Promise<DomainObservation | null> {
  return operation(target, options, async request => {
    const response = await request(
      `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(hostname)}`,
    )
    if (response.status === 404) return null
    if (response.status < 200 || response.status >= 300) providerError(response.status)
    try {
      return await observation(hostname, target, response.body, request, true)
    } catch (error) {
      if (error instanceof VercelDomainError && error.code === 'not_found') return null
      throw error
    }
  })
}

export function removeDomain(
  hostname: string,
  target: DomainTarget,
  options: VercelDomainOptions = {},
): Promise<void> {
  return operation(target, options, async request => {
    const path = `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(hostname)}`
    const current = await request(path)
    if (current.status === 404) return
    if (current.status < 200 || current.status >= 300) providerError(current.status)
    try {
      await inspectAssignment(hostname, target, current.body, request, true)
    } catch (error) {
      if (error instanceof VercelDomainError && error.code === 'not_found') return
      throw error
    }
    const removed = await request(path, { method: 'DELETE' })
    if (removed.status !== 404 && (removed.status < 200 || removed.status >= 300))
      providerError(removed.status)
  })
}

export function verifyDomain(
  hostname: string,
  target: DomainTarget,
  options: VercelDomainOptions = {},
): Promise<DomainObservation> {
  return operation(target, options, async request => {
    const response = await request(
      `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(hostname)}/verify`,
      { method: 'POST' },
    )
    if (response.status === 404)
      throw new VercelDomainError('not_found', 'Vercel domain assignment is missing', false, 404)
    if (response.status < 200 || response.status >= 300) providerError(response.status)
    return observation(hostname, target, response.body, request)
  })
}
