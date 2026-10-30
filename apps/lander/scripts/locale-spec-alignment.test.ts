import { expect, test } from 'bun:test'

import { getUseCaseJobs, getUseCasePersonas } from '../components/landing/use-cases/use-cases-spec'
import { getComparisons } from '../components/landing/vs/vs-spec'

function expectLocaleSlugsAligned(
  base: ReadonlyArray<{ slug: string }>,
  localized: ReadonlyArray<{ slug: string }>,
): void {
  expect(localized).toHaveLength(base.length)
  expect(localized.map(entry => entry.slug)).toEqual(base.map(entry => entry.slug))
}

test('Spanish locale specs stay positionally aligned with their English base entries', () => {
  expectLocaleSlugsAligned(getComparisons('en'), getComparisons('es-419'))
  expectLocaleSlugsAligned(getUseCaseJobs('en'), getUseCaseJobs('es-419'))
  expectLocaleSlugsAligned(getUseCasePersonas('en'), getUseCasePersonas('es-419'))
})
