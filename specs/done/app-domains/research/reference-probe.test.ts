import { expect, test } from 'bun:test'

import { runReferenceProbe } from './reference-probe'

test('replays the frozen add entry point with full request and readiness output', async () => {
  const report = await runReferenceProbe({ only: 'add-ready' })
  expect(report.provider).toEqual([
    {
      id: 'add-ready',
      requests: [
        {
          method: 'POST',
          pathname: '/v10/projects/project-placeholder/domains',
          query: [['teamId', 'team-placeholder']],
          headers: { authorization: '<redacted>', 'content-type': 'application/json' },
          body: '{"name":"example.com"}',
        },
        {
          method: 'GET',
          pathname: '/v6/domains/example.com/config',
          query: [['teamId', 'team-placeholder']],
          headers: { authorization: '<redacted>', 'content-type': 'application/json' },
          body: null,
        },
      ],
      outcome: {
        kind: 'return',
        value: {
          id: 'example.com',
          name: 'example.com',
          verified: true,
          misconfigured: false,
          verification: { $undefined: true },
          conflicts: { $undefined: true },
        },
      },
    },
  ])
})

test('replays ownership, routing, error and removal contracts without omitting outcomes', async () => {
  const report = await runReferenceProbe()
  const cases = new Map(report.provider.map(entry => [entry.id, entry]))
  expect(cases.get('read-subdomain-txt-cname')?.outcome).toEqual({
    kind: 'return',
    value: {
      id: 'tools.example.com',
      name: 'tools.example.com',
      verified: false,
      misconfigured: true,
      verification: [
        {
          type: 'TXT',
          domain: '_vercel.tools.example.com',
          value: 'ownership-placeholder',
          reason: 'pending-ownership',
        },
        { type: 'CNAME', domain: 'tools.example.com', value: 'preferred.vercel-dns.example' },
      ],
      conflicts: [{ name: 'tools.example.com', type: 'CNAME', value: 'old.example' }],
    },
  })
  expect(cases.get('read-missing')?.outcome).toEqual({ kind: 'return', value: null })
  expect(cases.get('remove-missing')?.outcome).toEqual({
    kind: 'return',
    value: { $undefined: true },
  })
})

test('executes actual manual-refresh and storage handlers, exposing retained DNS instructions', async () => {
  const report = await runReferenceProbe()
  const refresh = report.actions.find(entry => entry.id === 'refresh-clears-diagnostics')
  expect(refresh?.outcome).toEqual({ kind: 'return', value: { status: 'active' } })
  expect(refresh?.rows).toEqual([
    {
      _id: 'domain-1',
      organizationId: 'org-1',
      appSlug: 'dashboard',
      domain: 'tools.example.com',
      status: 'active',
      verification: [
        { type: 'TXT', domain: '_vercel.tools.example.com', value: 'stale-challenge' },
      ],
      verifiedAt: 1_800_000_000_000,
      lastCheckedAt: 1_800_000_000_000,
    },
  ])
})
