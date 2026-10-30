import { expect, test } from 'bun:test'

import { BACKEND_SCHEMA_VERSION } from '@repo/contract'

import { deploymentIdentity } from './deployment'

const revision = '0123456789abcdef0123456789abcdef01234567'

test('backend deployment identity accepts only an exact release revision', () => {
  expect(deploymentIdentity(revision)).toEqual({
    revision,
    schema: BACKEND_SCHEMA_VERSION,
  })
  expect(deploymentIdentity('short')).toEqual({
    revision: null,
    schema: BACKEND_SCHEMA_VERSION,
  })
  expect(deploymentIdentity(null)).toEqual({
    revision: null,
    schema: BACKEND_SCHEMA_VERSION,
  })
})
