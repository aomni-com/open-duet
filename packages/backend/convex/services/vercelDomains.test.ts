import { afterEach, expect, test } from 'bun:test'

import type { DomainTarget } from '@repo/contract'

import {
  addDomain,
  readDomain,
  removeDomain,
  verifyDomain,
  type VercelDomainOptions,
} from './vercelDomains'

const target: DomainTarget = {
  teamId: 'team-fixture',
  projectId: 'project-fixture',
  gitBranch: 'staging',
}
const assignment = {
  name: 'tools.example.com',
  apexName: 'example.com',
  projectId: target.projectId,
  gitBranch: target.gitBranch,
  verified: true,
}
const requests: Request[] = []
afterEach(() => {
  requests.length = 0
})
function transport(
  responses: Array<{ status?: number; body: unknown }>,
): NonNullable<VercelDomainOptions['fetch']> {
  return async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    const response = responses.shift()
    if (!response) throw new Error('Unscripted provider request')
    return Response.json(response.body, { status: response.status ?? 200 })
  }
}

test('adds the captured staging target and returns ownership and routing independently', async () => {
  const result = await addDomain(assignment.name, target, {
    token: 'fixture-token',
    fetch: transport([{ body: assignment }, { body: { misconfigured: false } }]),
  })
  expect(result).toEqual({
    hostname: assignment.name,
    apexName: assignment.apexName,
    ownershipVerified: true,
    misconfigured: false,
    records: [],
    conflicts: [],
    target: { projectId: target.projectId, gitBranch: 'staging' },
  })
  expect(await requests[0]!.json()).toEqual({ name: assignment.name, gitBranch: 'staging' })
  expect(requests.map(request => [request.method, request.url])).toEqual([
    ['POST', 'https://api.vercel.com/v10/projects/project-fixture/domains?teamId=team-fixture'],
    ['GET', 'https://api.vercel.com/v6/domains/tools.example.com/config?teamId=team-fixture'],
  ])
})

test('preserves ownership TXT, conflicts, and the best routing recommendation', async () => {
  const result = await readDomain(assignment.name, target, {
    token: 'fixture-token',
    fetch: transport([
      {
        body: {
          ...assignment,
          verified: false,
          verification: [
            { type: 'TXT', domain: '_vercel.example.com', value: 'ownership', reason: 'pending' },
          ],
        },
      },
      {
        body: {
          misconfigured: true,
          recommendedCNAME: [
            { rank: 2, value: 'other.example.' },
            { rank: 1, value: 'preferred.example.' },
          ],
          conflicts: [{ name: assignment.name, type: 'CNAME', value: 'previous.example' }],
        },
      },
    ]),
  })
  expect(result).toEqual({
    hostname: assignment.name,
    apexName: assignment.apexName,
    ownershipVerified: false,
    misconfigured: true,
    records: [
      { type: 'TXT', domain: '_vercel.example.com', value: 'ownership', reason: 'pending' },
      { type: 'CNAME', domain: assignment.name, value: 'preferred.example' },
    ],
    conflicts: [{ name: assignment.name, type: 'CNAME', value: 'previous.example' }],
    target: { projectId: target.projectId, gitBranch: 'staging' },
  })
})

test('inspects incomplete add metadata before accepting the captured target', async () => {
  const result = await addDomain(assignment.name, target, {
    token: 'fixture-token',
    fetch: transport([
      { body: { name: assignment.name, verified: true } },
      { body: assignment },
      { body: { misconfigured: false } },
    ]),
  })
  expect(result.target).toEqual({ projectId: target.projectId, gitBranch: 'staging' })
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/v10/projects/project-fixture/domains'],
    ['GET', '/v9/projects/project-fixture/domains/tools.example.com'],
    ['GET', '/v6/domains/tools.example.com/config'],
  ])
})

test('removes only after inspecting the current assignment and treats DELETE 404 as success', async () => {
  await removeDomain(assignment.name, target, {
    token: 'fixture-token',
    fetch: transport([
      { body: assignment },
      { status: 404, body: { error: { code: 'not_found' } } },
    ]),
  })
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['GET', '/v9/projects/project-fixture/domains/tools.example.com'],
    ['DELETE', '/v9/projects/project-fixture/domains/tools.example.com'],
  ])
})

test('verification validates provider branch rather than accepting a production alias', async () => {
  await expect(
    verifyDomain(assignment.name, target, {
      token: 'fixture-token',
      fetch: transport([{ body: { ...assignment, gitBranch: null } }]),
    }),
  ).rejects.toMatchObject({ code: 'target_mismatch', retryable: false })
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/v9/projects/project-fixture/domains/tools.example.com/verify'],
  ])
})

test('replays an already-assigned add only after reading the same target', async () => {
  const result = await addDomain(assignment.name, target, {
    token: 'fixture-token',
    fetch: transport([
      {
        status: 409,
        body: { error: { code: 'domain_already_in_use', message: 'Already assigned' } },
      },
      { body: assignment },
      { body: { misconfigured: false } },
    ]),
  })
  expect(result.hostname).toBe(assignment.name)
  expect(requests.map(request => request.method)).toEqual(['POST', 'GET', 'GET'])
})

test('selects staging or production from the existing deployment identity', async () => {
  const { appDomainTarget } = await import('../config')
  const staging = appDomainTarget({ DUET_EDGE_HOST: 'edge-staging.duet.so' })
  const production = appDomainTarget({ DUET_EDGE_HOST: 'edge.duet.so' })
  expect(staging.gitBranch).toBe('staging')
  expect(production).toEqual({ ...staging, gitBranch: null })
  expect(() => appDomainTarget({})).toThrow('DUET_EDGE_HOST')
  expect(() => appDomainTarget({ DUET_EDGE_HOST: 'foreign.example.com' })).toThrow('DUET_EDGE_HOST')
})

test('bounds a whole operation while a provider body never finishes', async () => {
  let signal: AbortSignal | null | undefined
  let cancelled = false
  const hangingFetch: NonNullable<VercelDomainOptions['fetch']> = async (input, init) => {
    signal = new Request(input, init).signal
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }
  await expect(
    readDomain(assignment.name, target, {
      token: 'fixture-token',
      fetch: hangingFetch,
      deadlineMs: 10,
    }),
  ).rejects.toMatchObject({ code: 'timeout', retryable: true })
  expect(signal?.aborted).toBe(true)
  expect(cancelled).toBe(true)
}, 1_000)

test('refuses oversized streamed responses before retaining provider data', async () => {
  let cancelled = false
  const oversizedFetch: NonNullable<VercelDomainOptions['fetch']> = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1_024 + 1))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  await expect(
    readDomain(assignment.name, target, {
      token: 'fixture-token',
      fetch: oversizedFetch,
      deadlineMs: 10,
    }),
  ).rejects.toMatchObject({ code: 'response_too_large', retryable: false })
  expect(cancelled).toBe(true)
})

test('refuses read, replay, and cleanup after a remote project or branch changes', async () => {
  for (const changed of [
    { ...assignment, projectId: 'other-project' },
    { ...assignment, gitBranch: null },
  ]) {
    for (const operation of [readDomain, addDomain, removeDomain]) {
      requests.length = 0
      const responses =
        operation === addDomain
          ? [
              { status: 409, body: { error: { code: 'domain_already_in_use' } } },
              { body: changed },
              { body: { misconfigured: false } },
            ]
          : [{ body: changed }, { body: { misconfigured: false } }]
      await expect(
        operation(assignment.name, target, { token: 'fixture-token', fetch: transport(responses) }),
      ).rejects.toMatchObject({ code: 'target_mismatch', retryable: false })
      expect(requests.some(request => request.method === 'DELETE')).toBe(false)
    }
  }
})

test('refuses an over-budget combined DNS list instead of dropping instructions', async () => {
  await expect(
    readDomain('example.com', target, {
      token: 'fixture-token',
      fetch: transport([
        {
          body: {
            ...assignment,
            name: 'example.com',
            verification: Array.from({ length: 31 }, (_, index) => ({
              type: 'TXT',
              domain: `_verification${index}.example.com`,
              value: `ownership-${index}`,
            })),
          },
        },
        {
          body: {
            misconfigured: true,
            recommendedIPv4: [{ rank: 1, value: ['192.0.2.10', '192.0.2.11'] }],
          },
        },
      ]),
    }),
  ).rejects.toMatchObject({ code: 'invalid_response', retryable: false })
})

test('requires the runtime token before making a provider request', async () => {
  await expect(
    readDomain(assignment.name, target, { token: '', fetch: transport([]) }),
  ).rejects.toMatchObject({ code: 'not_configured', retryable: false })
  expect(requests).toEqual([])
})

test('inspects omitted branch metadata on production add and verify before accepting it', async () => {
  const production = { ...target, gitBranch: null }
  const pointAssignment = { ...assignment, gitBranch: undefined }
  for (const operation of [addDomain, verifyDomain]) {
    requests.length = 0
    const result = await operation(assignment.name, production, {
      token: 'fixture-token',
      fetch: transport([
        { body: pointAssignment },
        { body: pointAssignment },
        { body: { misconfigured: false } },
      ]),
    })
    expect(result.target).toEqual({ projectId: target.projectId, gitBranch: null })
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET', 'GET'])
  }
})

test('settles assignment absence discovered during metadata inspection', async () => {
  for (const operation of [readDomain, removeDomain]) {
    requests.length = 0
    const result = await operation(assignment.name, target, {
      token: 'fixture-token',
      fetch: transport([
        { body: { name: assignment.name, verified: true } },
        { status: 404, body: { error: { code: 'not_found' } } },
      ]),
    })
    expect(result).toBe(operation === readDomain ? null : undefined)
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
  }
})
