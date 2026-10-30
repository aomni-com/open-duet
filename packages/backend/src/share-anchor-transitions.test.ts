import { describe, expect, test } from 'bun:test'

import { resolveShareAnchorTransition } from '../convex/domains/shares/anchorTransitions'

const baseEvidence = {
  anchorPath: 'shared/project',
  anchorPathExists: false,
  consecutiveMissingPolls: 1,
  candidates: [],
  markerMatches: [],
  linkedPaths: [],
  targetConflict: false,
}

describe('share anchor transition policy', () => {
  test('same-inode marker-backed move relocates', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        candidates: [
          {
            fromPath: 'shared/project',
            toPath: 'shared/project-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        markerMatches: ['shared/project-renamed'],
      }),
    ).toEqual({ kind: 'relocate', toPath: 'shared/project-renamed' })
  })

  test('one marker elsewhere relocates after a cross-filesystem move', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        markerMatches: ['archive/project'],
      }),
    ).toEqual({ kind: 'relocate', toPath: 'archive/project' })
  })

  test('replaying an acknowledged marker-only relocation is unchanged', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        anchorPath: 'archive/project',
        markerMatches: ['archive/project'],
        missingIsConclusive: true,
      }),
    ).toEqual({ kind: 'unchanged' })
  })

  test('first marker-negative miss remains unchanged', () => {
    expect(resolveShareAnchorTransition(baseEvidence)).toEqual({ kind: 'unchanged' })
  })

  test('one conclusive marker-negative search unlinks without a second full-drive walk', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        missingIsConclusive: true,
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('second marker-negative miss unlinks', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        consecutiveMissingPolls: 2,
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('multiple marker matches unlink instead of guessing', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        markerMatches: ['copies/project-a', 'copies/project-b'],
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('a present old path with the wrong marker waits instead of following a copied marker', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        anchorPathExists: true,
        markerMatches: ['copies/project'],
      }),
    ).toEqual({ kind: 'unchanged' })
  })

  test('a persistently present old path with the wrong marker unlinks', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        anchorPathExists: true,
        consecutiveMissingPolls: 2,
        markerMatches: ['copies/project'],
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('a destination nested with another linked root unlinks', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        markerMatches: ['shared/container/project'],
        linkedPaths: ['shared/container'],
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('a destination containing another linked root unlinks', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        markerMatches: ['shared'],
        linkedPaths: ['shared/other-project'],
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('an exact target conflict unlinks', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        markerMatches: ['shared/taken'],
        targetConflict: true,
      }),
    ).toEqual({ kind: 'unlink' })
  })

  test('a mid-walk report without an observed miss remains unchanged', () => {
    expect(
      resolveShareAnchorTransition({
        ...baseEvidence,
        consecutiveMissingPolls: 0,
      }),
    ).toEqual({ kind: 'unchanged' })
  })
})
