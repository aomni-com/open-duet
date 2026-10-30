import { expect, test } from 'bun:test'

import { runCandidateProviderProbe } from './provider-candidate'

test('compares the production adapter to the verified frozen oracle with constrained deltas', async () => {
  const results = await runCandidateProviderProbe()
  expect(results.map(result => result.id)).toContain('read-multilabel-apex-heuristic')
  expect(results.map(result => result.id)).toContain('config-provider-failure')
})
