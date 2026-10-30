import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import type { DomainTarget } from '@repo/contract'

import {
  addDomain,
  readDomain,
  verifyDomain,
  removeDomain,
  VercelDomainError,
} from '../../../../packages/backend/convex/services/vercelDomains'
import {
  loadProviderFixtures,
  runControlledResponses,
  runReferenceProbe,
  type ProviderFixture,
} from './reference-probe'

type CandidateFixture = Omit<ProviderFixture, 'expected'> & {
  referenceCaseId: string
  deltas: string[]
}
type RequestTrace = {
  method: string
  pathname: string
  query: Array<[string, string]>
  headers: Record<string, string>
  body: string | null
}

function intentionalDelta(
  reference: ProviderFixture,
  trace: Awaited<ReturnType<typeof runControlledResponses>>,
  target: DomainTarget,
) {
  const requests = structuredClone(trace.requests) as RequestTrace[]
  const responses = structuredClone(reference.responses)
  const deltas: string[] = []
  const apexName = reference.domain === 'example.co.uk' ? 'example.co.uk' : 'example.com'
  const assignment = {
    name: reference.domain,
    apexName,
    verified: true,
    projectId: target.projectId,
    gitBranch: target.gitBranch,
  }
  const inspection: RequestTrace = {
    method: 'GET',
    pathname: `/v9/projects/${target.projectId}/domains/${reference.domain}`,
    query: [['teamId', target.teamId]],
    headers: { authorization: '<redacted>', 'content-type': 'application/json' },
    body: null,
  }
  if (reference.operation === 'add') {
    const request = requests[0]!
    assert.deepEqual(JSON.parse(request.body!), { name: reference.domain })
    request.body = JSON.stringify({ name: reference.domain, gitBranch: target.gitBranch })
    deltas.push('captured-staging-branch')
  }
  if (reference.operation === 'remove') {
    responses.unshift({ status: 200, body: assignment })
    requests.unshift(inspection)
    deltas.push('inspect-current-assignment-before-delete')
  } else if (responses[0]!.status === 200) {
    const supplied = reference.responses[0]!.body as { name: string; verified: boolean }
    assert.equal(supplied.name, reference.domain)
    responses.splice(1, 0, { status: 200, body: { ...assignment, ...supplied } })
    requests.splice(1, 0, inspection)
    deltas.push('inspect-missing-target-metadata')
  }

  let outcome: unknown = trace.outcome
  let errorDetails: Pick<VercelDomainError, 'code' | 'retryable' | 'status'> | undefined
  const referenceOutcome = trace.outcome as {
    kind: 'return' | 'throw'
    value?: {
      name: string
      verified: boolean
      misconfigured: boolean
      verification: unknown
      conflicts: unknown
    } | null
  }
  if (referenceOutcome.kind === 'throw') {
    const status = reference.responses.find(response => response.status >= 400)!.status
    outcome = {
      kind: 'throw',
      error: { name: 'VercelDomainError', message: `Vercel domain request failed (${status})` },
    }
    errorDetails = { code: 'provider_error', retryable: status === 429 || status >= 500, status }
    deltas.push('typed-bounded-error')
  } else if (referenceOutcome.value?.name) {
    const value = referenceOutcome.value
    let records = Array.isArray(value.verification) ? value.verification : []
    if (reference.id === 'read-multilabel-apex-heuristic') {
      // The added point inspection declares this complete hostname as the apex;
      // its A recommendations intentionally replace the old CNAME.
      records = [
        { type: 'A', domain: reference.domain, value: '192.0.2.10' },
        { type: 'A', domain: reference.domain, value: '192.0.2.11' },
      ]
      deltas.push('provider-apex-name-corrects-multilabel-apex')
    }
    outcome = {
      kind: 'return',
      value: {
        hostname: value.name,
        apexName,
        ownershipVerified: (reference.responses[0]!.body as { verified: boolean }).verified,
        misconfigured: value.misconfigured,
        records,
        conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
        target: { projectId: target.projectId, gitBranch: target.gitBranch },
      },
    }
    deltas.push('independent-ownership-and-routing-arrays')
  }
  return {
    responses,
    deltas,
    expected: { requests, outcome, ...(errorDetails ? { errorDetails } : {}) },
  }
}

export async function runCandidateProviderProbe() {
  const corpus: { target: DomainTarget; token: string; cases: CandidateFixture[] } = JSON.parse(
    await readFile(new URL('./provider-candidate-fixtures.json', import.meta.url), 'utf8'),
  )
  // This rechecks the frozen identities and executes the unchanged source, so
  // editable candidate fixtures can never become their own parity oracle.
  const reference = await runReferenceProbe()
  const fixtures = await loadProviderFixtures()
  assert.deepEqual(corpus.target, {
    teamId: fixtures.configuration.VERCEL_TEAM_ID,
    projectId: fixtures.configuration.VERCEL_SANDBOX_GATEWAY_PROJECT_ID,
    gitBranch: 'staging',
  })
  assert.equal(corpus.token, fixtures.configuration.VERCEL_TOKEN)
  assert.deepEqual(
    corpus.cases.map(fixture => fixture.referenceCaseId),
    fixtures.cases.map(fixture => fixture.id),
  )
  const provider = { add: addDomain, read: readDomain, verify: verifyDomain, remove: removeDomain }
  const results = []
  for (const [index, fixture] of corpus.cases.entries()) {
    const frozenFixture = fixtures.cases[index]!
    assert.deepEqual(
      { id: fixture.id, operation: fixture.operation, domain: fixture.domain },
      { id: frozenFixture.id, operation: frozenFixture.operation, domain: frozenFixture.domain },
    )
    const transformed = intentionalDelta(frozenFixture, reference.provider[index]!, corpus.target)
    assert.deepEqual(
      fixture.responses,
      transformed.responses,
      `Matched provider inputs: ${fixture.id}`,
    )
    assert.deepEqual(fixture.deltas, transformed.deltas, `Constrained deltas: ${fixture.id}`)
    let errorDetails: Pick<VercelDomainError, 'code' | 'retryable' | 'status'> | undefined
    const trace = await runControlledResponses(fixture.id, fixture.responses, async () => {
      try {
        return await provider[fixture.operation](fixture.domain, corpus.target, {
          token: corpus.token,
        })
      } catch (error) {
        if (error instanceof VercelDomainError)
          errorDetails = { code: error.code, retryable: error.retryable, status: error.status }
        throw error
      }
    })
    const result = { ...trace, ...(errorDetails ? { errorDetails } : {}) }
    assert.deepEqual(
      {
        requests: result.requests,
        outcome: result.outcome,
        ...(errorDetails ? { errorDetails } : {}),
      },
      transformed.expected,
      `Production/reference parity: ${fixture.id}`,
    )
    results.push(result)
  }
  return results
}

if (import.meta.main)
  process.stdout.write(`${JSON.stringify(await runCandidateProviderProbe(), null, 2)}\n`)
