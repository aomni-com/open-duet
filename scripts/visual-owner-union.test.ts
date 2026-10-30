import { describe, expect, test } from 'bun:test'

import type { VisualCoverageEntry } from './visual-coverage-core'
import {
  missingVisualFilters,
  REQUIRED_VISUAL_OWNERS,
  type SharedUiEntry,
  validateVisualOwnerUnion,
  type VisualOwnerName,
} from './visual-owner-union'

const route = (target: string, value: string): VisualCoverageEntry => ({
  target,
  kind: 'route',
  route: value,
})

function completeLedgers(): Map<VisualOwnerName, readonly (VisualCoverageEntry | SharedUiEntry)[]> {
  return new Map([
    ['lander', [route('lander#Page', '/')]],
    ['web', [{ target: 'web#Fixture', kind: 'fixture', fixture: 'ui-primitives' }]],
    ['docs', [route('docs#Page', '/getting-started')]],
    ['ui', [{ target: 'ui#Button', kind: 'owned-by', owner: 'web:fixture:ui-primitives' }]],
    ['official-apps', [{ target: 'agents/account-board', kind: 'fixture', fixture: 'empty' }]],
  ])
}

describe('visual owner union', () => {
  test('includes official apps as an independent visual owner', () => {
    expect(REQUIRED_VISUAL_OWNERS).toEqual(['lander', 'web', 'docs', 'ui', 'official-apps'])
  })

  test('requires every independent owner and exact unique rows', () => {
    expect(validateVisualOwnerUnion(completeLedgers())).toEqual([])

    const missing = completeLedgers()
    missing.delete('docs')
    expect(validateVisualOwnerUnion(missing)).toContain('missing visual owner ledger: docs')

    const duplicate = completeLedgers()
    duplicate.set('web', [route('same', '/'), route('same', '/elsewhere')])
    expect(validateVisualOwnerUnion(duplicate)).toContain(
      'duplicate targets in visual owner ledger: web',
    )
  })

  test('rejects a shared UI row whose app fixture or route disappeared', () => {
    const ledgers = completeLedgers()
    ledgers.set('ui', [
      { target: 'ui#Button', kind: 'owned-by', owner: 'web:fixture:removed-fixture' },
    ])
    expect(validateVisualOwnerUnion(ledgers)).toContain(
      'shared UI references unknown owner: web:fixture:removed-fixture',
    )
  })

  test('fails orchestration when any owner filter is removed', () => {
    const complete =
      '--filter=lander --filter=web --filter=docs --filter=@repo/ui --filter=@repo/official-agents-seed'
    expect(missingVisualFilters(complete)).toEqual([])
    expect(missingVisualFilters(complete.replace(' --filter=docs', ''))).toEqual(['docs'])
    expect(
      missingVisualFilters(complete.replace(' --filter=@repo/official-agents-seed', '')),
    ).toEqual(['official-apps'])
  })
})
