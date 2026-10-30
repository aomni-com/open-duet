import { expect, test } from 'bun:test'

import {
  assertAppDomainRelease,
  assertAppDomainResponse,
  assertAppDomainGrantReplay,
} from './staging-live-app-domains'

test('domain acceptance rejects a wrong app and enforces the two host indexing policies', async () => {
  const response = (marker = 'fixture', robots?: string) =>
    new Response(`<h1>${marker}</h1>`, {
      headers: {
        'x-app-domains-marker': marker,
        'x-app-domains-path': '/deep',
        'x-app-domains-query': '?q=1',
        'x-app-domains-host': 'aomni.co',
        ...(robots === undefined ? {} : { 'x-robots-tag': robots }),
      },
    })
  const expected = { marker: 'fixture', host: 'aomni.co', path: '/deep?q=1' }
  await assertAppDomainResponse(response(), { ...expected, indexing: 'custom' })
  await expect(
    assertAppDomainResponse(response('other'), { ...expected, indexing: 'custom' }),
  ).rejects.toThrow('wrong app marker')
  await expect(
    assertAppDomainResponse(response(), { ...expected, indexing: 'standard' }),
  ).rejects.toThrow('Duet host lost noindex')
  await expect(
    assertAppDomainResponse(response('fixture', 'index'), { ...expected, indexing: 'opt-out' }),
  ).rejects.toThrow('app opt-out was lost')
})

test('domain acceptance tolerates an omitted empty query echo without accepting a lost query', async () => {
  const response = () =>
    new Response('<h1>fixture</h1>', {
      headers: {
        'x-app-domains-marker': 'fixture',
        'x-app-domains-host': 'aomni.co',
        'x-app-domains-path': '/deep',
      },
    })
  const expected = { marker: 'fixture', host: 'aomni.co', indexing: 'custom' as const }
  await assertAppDomainResponse(response(), { ...expected, path: '/deep' })
  await expect(
    assertAppDomainResponse(response(), { ...expected, path: '/deep?q=1' }),
  ).rejects.toThrow('App origin lost original host/path/query')
})

test('domain acceptance refuses mixed revisions or a non-staging edge assignment', () => {
  const revision = 'a'.repeat(40)
  const input = {
    hostname: 'aomni.co',
    target: { projectId: 'fixture-project', gitBranch: 'staging' },
    api: { revision, backend: { revision, schema: 1 }, runtime: { version: 'runtime' } },
    web: { revision, cacheSchema: 14 },
    docs: { revision },
    alias: {
      alias: 'aomni.co',
      projectId: 'fixture-project',
      deploymentId: 'deployment',
    },
    deployment: {
      id: 'deployment',
      readyState: 'READY',
      gitSource: null,
      meta: { githubCommitSha: revision, githubCommitRef: 'staging' },
    },
  }
  expect(assertAppDomainRelease(input).edge).toBe(revision)
  expect(() =>
    assertAppDomainRelease({
      ...input,
      alias: { ...input.alias, projectId: 'another-project' },
    }),
  ).toThrow('routed to another project')
  expect(
    assertAppDomainRelease({
      ...input,
      deployment: {
        id: 'deployment',
        readyState: 'READY',
        gitMetadata: { commitSha: revision, commitRef: 'staging' },
      },
    }).edge,
  ).toBe(revision)
  expect(() =>
    assertAppDomainRelease({ ...input, web: { ...input.web, revision: 'b'.repeat(40) } }),
  ).toThrow('release revisions do not match')
  expect(() =>
    assertAppDomainRelease({
      ...input,
      deployment: {
        ...input.deployment,
        meta: { ...input.deployment.meta, githubCommitRef: 'production' },
      },
    }),
  ).toThrow('non-staging')
})

test('domain release refuses stale docs even when serving owners agree', () => {
  const revision = 'a'.repeat(40)
  expect(() =>
    assertAppDomainRelease({
      hostname: 'aomni.co',
      target: { projectId: 'fixture-project', gitBranch: 'staging' },
      api: { revision, backend: { revision, schema: 1 }, runtime: { version: 'runtime' } },
      web: { revision, cacheSchema: 14 },
      docs: { revision: 'b'.repeat(40) },
      alias: {
        alias: 'aomni.co',
        projectId: 'fixture-project',
        deploymentId: 'deployment',
      },
      deployment: {
        id: 'deployment',
        readyState: 'READY',
        meta: { githubCommitSha: revision, githubCommitRef: 'staging' },
      },
    }),
  ).toThrow('release revisions do not match')
})

test('grant replay completed after expiry cannot count as durable app identity proof', () => {
  expect(() =>
    assertAppDomainGrantReplay(new Response(null, { status: 403 }), 1_000, 1_001),
  ).toThrow('completed after launch lifetime')
  expect(() =>
    assertAppDomainGrantReplay(new Response(null, { status: 403 }), 1_000, 999),
  ).not.toThrow()
})
