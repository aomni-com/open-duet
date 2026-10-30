import { expect, test } from 'bun:test'

import {
  inspectModelRefreshProbe,
  MODEL_REFRESH_MEDIA,
} from './staging-live-model-refresh-evidence'

function completedProbe() {
  return {
    status: 'complete',
    roles: MODEL_REFRESH_MEDIA,
    trainExitCode: 0,
    generations: ['image:google', 'video:google', 'video:grok', 'video:seedance'].map(role => ({
      role,
      model: MODEL_REFRESH_MEDIA[role as keyof typeof MODEL_REFRESH_MEDIA],
      exitCode: 0,
      bytes: 1024,
      validMedia: true,
    })),
    nondefault: ['spacexai/grok-4.7', 'zai/glm-5.3'].map(model => ({
      model,
      responseModel: model,
      result: '42',
    })),
  }
}

test('a successful old-model artifact cannot pass the refreshed media gate', () => {
  const receipt = completedProbe()
  expect(() =>
    inspectModelRefreshProbe({
      ...receipt,
      generations: receipt.generations.map((row, index) =>
        index === 0 ? { ...row, model: 'google/gemini-3.1-flash-image-preview' } : row,
      ),
    }),
  ).toThrow('wrong concrete model')
})

test('an unavailable nondefault provider is incomplete, never a silently skipped success', () => {
  expect(() => inspectModelRefreshProbe({ ...completedProbe(), nondefault: [] })).toThrow(
    'missing spacexai/grok-4.7',
  )
})

test('accepts complete media and internal receipts while refusing partial or empty outputs', () => {
  const receipt = completedProbe()
  expect(inspectModelRefreshProbe(receipt)).toEqual(receipt)
  expect(() => inspectModelRefreshProbe({ ...receipt, status: 'failed' })).toThrow(
    'did not complete',
  )
  expect(() =>
    inspectModelRefreshProbe({ ...receipt, generations: receipt.generations.slice(1) }),
  ).toThrow('missing image:google')
  expect(() =>
    inspectModelRefreshProbe({
      ...receipt,
      generations: receipt.generations.map(row => ({ ...row, bytes: 0 })),
    }),
  ).toThrow('produced no media')
})

test('a correct answer from a retired provider model is not refreshed execution', () => {
  const receipt = completedProbe()
  expect(() =>
    inspectModelRefreshProbe({
      ...receipt,
      nondefault: receipt.nondefault.map(row => ({ ...row, responseModel: 'grok-4.6' })),
    }),
  ).toThrow('unexpected response model')
})
