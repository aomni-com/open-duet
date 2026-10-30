import { expect, test } from 'bun:test'

import { DocsDeploymentSchema } from '@repo/contract'

import { docsReleaseRevision, GET } from './route'

const revision = '0123456789abcdef0123456789abcdef01234567'

test('static deployment probe exposes only a full build revision', async () => {
  expect(docsReleaseRevision({ VERCEL_GIT_COMMIT_SHA: revision })).toBe(revision)
  expect(docsReleaseRevision({ VERCEL_GIT_COMMIT_SHA: 'short' })).toBeNull()

  const response = GET()
  expect(response.status).toBe(200)
  expect(DocsDeploymentSchema.parse(await response.json())).toEqual({
    revision: docsReleaseRevision(process.env),
  })
})
