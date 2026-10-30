import assert from 'node:assert/strict'

/** Frozen release acceptance targets, independent of the catalog being upgraded. */
export const MODEL_REFRESH_MEDIA = {
  'image:google': 'google/gemini-3.1-flash-image',
  'video:google': 'google/veo-3.1-generate-001',
  'video:grok': 'spacexai/grok-imagine-video-1.5',
  'video:pro': 'bytedance/seedance-2.5',
  'video:seedance': 'bytedance/seedance-2.5',
  video: 'bytedance/seedance-2.0-fast',
} as const

export function inspectModelRefreshProbe(value: unknown) {
  assert(value && typeof value === 'object', 'missing model refresh probe receipt')
  const receipt = value as Record<string, unknown>
  assert.equal(receipt.status, 'complete', 'model refresh CLI probe did not complete')
  assert.deepEqual(receipt.roles, MODEL_REFRESH_MEDIA, 'installed media role reference is stale')
  assert(Array.isArray(receipt.generations), 'missing CLI generation receipts')
  const generations = (receipt.generations as unknown[]).map(asRecord)
  for (const role of ['image:google', 'video:google', 'video:grok', 'video:seedance']) {
    const generation = generations.find(row => row.role === role)
    assert(generation, `missing ${role} CLI generation`)
    assert.equal(
      generation.model,
      MODEL_REFRESH_MEDIA[role as keyof typeof MODEL_REFRESH_MEDIA],
      `${role} wrong concrete model`,
    )
    assert.equal(generation.exitCode, 0, `${role} CLI failed`)
    assert(
      typeof generation.bytes === 'number' &&
        Number.isSafeInteger(generation.bytes) &&
        generation.bytes > 0,
      `${role} produced no media`,
    )
    assert.equal(generation.validMedia, true, `${role} output is not recognized media`)
  }
  assert(Array.isArray(receipt.nondefault), 'missing nondefault provider receipts')
  const nondefault = (receipt.nondefault as unknown[]).map(asRecord)
  for (const model of ['spacexai/grok-4.7', 'zai/glm-5.3']) {
    const result = nondefault.find(row => row.model === model)
    assert(result, `missing ${model} live receipt`)
    assert.equal(result.result, '42', `${model} failed the checkable task`)
    assert(
      typeof result.responseModel === 'string' &&
        [model, model.split('/')[1]].includes(result.responseModel.toLowerCase()),
      `${model} unexpected response model`,
    )
  }
  assert.equal(receipt.trainExitCode, 0, 'internal train call failed')
  return receipt
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid probe record')
  return value as Record<string, unknown>
}
