import { expect, test } from 'bun:test'

import { gatewayLivenessPaths } from './staging-live-gateway-liveness'

test('gateway-liveness fixture keeps generated and authored paths in a run-isolated subtree', () => {
  const paths = gatewayLivenessPaths('run / 東京-123')
  const other = gatewayLivenessPaths('run-456')
  expect(paths.root).not.toBe(other.root)
  expect(paths.root).toMatch(/^gateway-liveness\/[a-zA-Z0-9-]+$/)
  for (const path of Object.values(paths)) {
    expect(path === paths.root || path.startsWith(`${paths.root}/`)).toBe(true)
    expect(path.split('/')).not.toContain('..')
  }
  expect(paths.git).toBe(`${paths.root}/.git/objects/pack/a`)
  expect(paths.modules).toBe(`${paths.root}/node_modules/pkg/cache/a`)
  expect(paths.file).toBe(`${paths.root}/authored/renamed/final.txt`)
})
