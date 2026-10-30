import { describe, expect, test } from 'bun:test'

import {
  REAP_MISSING_POLLS,
  OBVIOUS_RENAME_CONFIDENCE,
  INODE_MATCH_CONFIDENCE_BONUS,
  effectiveRenameConfidence,
  resolveAnchorRenameDecisions,
} from '../convex/domains/anchors/renameDecision'

describe('anchor rename decision logic', () => {
  test('single high-confidence candidate reanchors the anchor path', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'apps/site', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/site-renamed'],
          candidates: [
            {
              fromPath: 'apps/site',
              toPath: 'apps/site-renamed',
              confidence: 0.92,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
        },
      ],
    )

    expect(decision).toEqual({
      action: 'reanchor',
      anchorId: 'a1',
      fromPath: 'apps/site',
      toPath: 'apps/site-renamed',
      confidence: 1,
      inodeMatch: true,
      markerMatch: true,
    })
  })

  test('replaying an acknowledged reanchor report is an idempotent no-op', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/writer-renamed', kind: 'agent' }],
      [
        {
          anchorId: 'a1',
          candidates: [
            {
              fromPath: 'agents/writer',
              toPath: 'agents/writer-renamed',
              confidence: 0.75,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['agents/writer-renamed'],
          missingIsConclusive: true,
        },
      ],
    )

    expect(decision).toEqual({
      action: 'wait',
      anchorId: 'a1',
      path: 'agents/writer-renamed',
    })
  })

  test('replaying an acknowledged marker-only reanchor is an idempotent no-op', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/writer-restored', kind: 'agent' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['agents/writer-restored'],
          missingIsConclusive: true,
        },
      ],
    )

    expect(decision).toEqual({
      action: 'wait',
      anchorId: 'a1',
      path: 'agents/writer-restored',
    })
  })

  test('two candidates break instead of guessing', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'apps/site', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/site-a', 'apps/site-b'],
          candidates: [
            {
              fromPath: 'apps/site',
              toPath: 'apps/site-a',
              confidence: 0.95,
              inodeMatch: true,
              markerMatch: true,
            },
            {
              fromPath: 'apps/site',
              toPath: 'apps/site-b',
              confidence: 0.95,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
        },
      ],
    )

    expect(decision).toMatchObject({
      action: 'broken',
      anchorId: 'a1',
      path: 'apps/site',
      reason: 'ambiguous',
    })
  })

  test('delete and recreate elsewhere breaks when there is no clear successor', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'apps/site', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
          candidates: [
            {
              fromPath: 'apps/site',
              toPath: 'elsewhere/site',
              confidence: 0.3,
              inodeMatch: false,
              markerMatch: false,
            },
          ],
        },
      ],
    )

    expect(decision).toMatchObject({
      action: 'broken',
      anchorId: 'a1',
      path: 'apps/site',
      reason: 'low_confidence',
    })
  })

  // The filesystem is the source of truth, so a folder that is simply gone —
  // absent at its path, no inode successor, and its marker nowhere on the drive
  // — means the app or agent is gone, not that it needs repair. Breaking it
  // instead is what left deleted agents' apps sitting in "folder link needs
  // repair" forever with nothing that could ever clear them.
  test('a folder that is gone for good reaps the row instead of breaking it', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/fired/apps/board', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS,
          markerMatches: [],
        },
      ],
    )

    expect(decision).toEqual({
      action: 'reap',
      anchorId: 'a1',
      path: 'agents/fired/apps/board',
      kind: 'app',
      consecutiveMissingPolls: REAP_MISSING_POLLS,
    })
  })

  // An install's anchor exists from the moment the row is written, before a
  // single byte has landed on the drive. Its folder is EXPECTED to be missing
  // until the pull arrives, however conclusively the drive says so today — a
  // reap here deletes the agent the user just picked.
  test('a folder that is still arriving is never reaped, however conclusive the miss', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/picked', kind: 'agent', arriving: true }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS,
          markerMatches: [],
          missingIsConclusive: true,
        },
      ],
    )

    expect(decision).toEqual({ action: 'wait', anchorId: 'a1', path: 'agents/picked' })
  })

  test('one conclusive mover search reaps a missing folder without repeated full-drive walks', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/fired/apps/board', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
          missingIsConclusive: true,
        },
      ],
    )

    expect(decision).toMatchObject({ action: 'reap', anchorId: 'a1' })
  })

  // Everything below is a guard on the one irreversible decision in this table.
  // Each case differs from the reap case above in exactly one dimension.
  //
  // A folder that is gone but not yet gone for long enough changes NOTHING. It
  // does not pass through `broken` on its way to being reaped: a user who just
  // deleted a folder would be told for a few seconds that their app needs its
  // folder link repaired, which is both false and un-actionable.
  test('a folder gone for too few polls changes nothing at all', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/fired/apps/board', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS - 1,
          markerMatches: [],
        },
      ],
    )

    expect(decision).toEqual({
      action: 'wait',
      anchorId: 'a1',
      path: 'agents/fired/apps/board',
    })
  })

  // A folder whose marker turns up elsewhere moved; we just could not pair it by
  // inode (a copy-then-delete, a restore from backup). Deleting the row would
  // throw away an app whose folder is sitting right there.
  test('one marker elsewhere reanchors even when a restore changed the inode', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/fired/apps/board', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS * 10,
          markerMatches: ['moved/board'],
        },
      ],
    )

    expect(decision).toMatchObject({
      action: 'reanchor',
      fromPath: 'agents/fired/apps/board',
      toPath: 'moved/board',
      markerMatch: true,
      inodeMatch: false,
    })
  })

  test('a folder still occupying its path is a repair case, never a reap', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'agents/fired/apps/board', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: true,
          consecutiveMissingPolls: REAP_MISSING_POLLS * 10,
          markerMatches: [],
        },
      ],
    )

    expect(decision).toMatchObject({ action: 'broken', reason: 'no_candidate' })
  })

  // A publish is the folder or file it serves. Delete that and the publish has
  // nothing left to serve, so the row goes too rather than lingering as a URL
  // pointing at nothing.
  test('a publish whose target is gone is reaped like any other row', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'sites/launch', kind: 'publish' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS,
          markerMatches: [],
        },
      ],
    )

    expect(decision).toMatchObject({ action: 'reap', kind: 'publish' })
  })

  // A share is an agreement between two workspaces, not a thing on this drive;
  // its own transition rail decides what a vanished mount means.
  test('a share anchor is never reaped and still breaks', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'shared/project', kind: 'share-mount' }],
      [
        {
          anchorId: 'a1',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: REAP_MISSING_POLLS * 10,
          markerMatches: [],
        },
      ],
    )

    expect(decision).toMatchObject({ action: 'broken', reason: 'no_candidate' })
  })

  test('inode match raises confidence into the obvious rename band', () => {
    const baseConfidence = OBVIOUS_RENAME_CONFIDENCE - INODE_MATCH_CONFIDENCE_BONUS / 2
    expect(
      effectiveRenameConfidence({
        fromPath: 'apps/site',
        toPath: 'apps/site-renamed',
        confidence: baseConfidence,
        inodeMatch: false,
        markerMatch: true,
      }),
    ).toBe(baseConfidence)
    const decision = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'apps/site', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/site-renamed'],
          candidates: [
            {
              fromPath: 'apps/site',
              toPath: 'apps/site-renamed',
              confidence: baseConfidence,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
        },
      ],
    )[0]
    expect(decision).toMatchObject({ action: 'reanchor', inodeMatch: true, markerMatch: true })
    expect(decision?.action === 'reanchor' ? decision.confidence : 0).toBeCloseTo(
      Math.min(1, baseConfidence + INODE_MATCH_CONFIDENCE_BONUS),
    )
  })

  test('inode reuse without marker match breaks instead of reanchoring', () => {
    const [decision] = resolveAnchorRenameDecisions(
      [{ anchorId: 'a1', path: 'apps/break-me', kind: 'app' }],
      [
        {
          anchorId: 'a1',
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
          candidates: [
            {
              fromPath: 'apps/break-me',
              toPath: 'elsewhere',
              confidence: 0.75,
              inodeMatch: true,
              markerMatch: false,
            },
          ],
        },
      ],
    )

    expect(decision).toMatchObject({
      action: 'broken',
      anchorId: 'a1',
      path: 'apps/break-me',
      reason: 'low_confidence',
    })
  })
})
