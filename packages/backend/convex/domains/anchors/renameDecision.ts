import type { AnchorKind, RenameCandidate } from '@repo/contract'

export const OBVIOUS_RENAME_CONFIDENCE = 0.8
export const INODE_MATCH_CONFIDENCE_BONUS = 0.2

/**
 * Consecutive polls with the folder absent before its rows are deleted rather
 * than broken. Deletion is the one decision here that cannot be undone, so it
 * waits for the drive to say the same thing several times running: at the 5s
 * active sync cadence that is a fraction of a minute, and it costs a mid-write
 * `mv` nothing.
 */
export const REAP_MISSING_POLLS = 3

/**
 * Anchor kinds whose row IS the thing at that path, so a vanished folder means a
 * vanished entity: an app, an agent, or a publish of a folder or file.
 *
 * Share anchors are absent because a share is an agreement between two
 * workspaces rather than a thing on this drive, and it has its own transition
 * rail that unlinks on the same evidence.
 */
const REAPABLE_KINDS: readonly AnchorKind[] = ['app', 'agent', 'publish']

export interface AnchoredPath {
  anchorId: string
  path: string
  kind: AnchorKind
  /** The folder is expected to be absent: its install has not landed yet. */
  arriving?: boolean
}

export interface AnchorMoveCandidates {
  anchorId: string
  candidates: RenameCandidate[]
  /** Whether something still occupies the anchor's own path this poll. */
  anchorPathExists: boolean
  /** Polls in a row that failed to find the anchor, reset by any successful sighting. */
  consecutiveMissingPolls: number
  /** Other paths on the drive carrying this anchor's marker — a moved folder we could not pair by inode. */
  markerMatches: string[]
  /** The gateway completed its one mover search (or hit its abnormal hard ceiling). */
  missingIsConclusive?: boolean
}

export type RenameDecision =
  | {
      action: 'reanchor'
      anchorId: string
      fromPath: string
      toPath: string
      confidence: number
      inodeMatch: boolean
      markerMatch: boolean
    }
  | {
      action: 'broken'
      anchorId: string
      path: string
      reason: 'missing_anchor' | 'no_candidate' | 'ambiguous' | 'low_confidence'
      candidates: RenameCandidate[]
    }
  | {
      action: 'reap'
      anchorId: string
      path: string
      kind: AnchorKind
      consecutiveMissingPolls: number
    }
  /** The folder is gone but not for long enough yet. Change nothing. */
  | { action: 'wait'; anchorId: string; path: string }

export function resolveAnchorRenameDecisions(
  anchors: AnchoredPath[],
  reports: AnchorMoveCandidates[],
): RenameDecision[] {
  const byId = new Map(anchors.map(anchor => [anchor.anchorId, anchor]))
  return reports.map(report => {
    const anchor = byId.get(report.anchorId)
    if (anchor === undefined) {
      return {
        action: 'broken',
        anchorId: report.anchorId,
        path: '',
        reason: 'missing_anchor',
        candidates: report.candidates,
      }
    }
    if (
      report.candidates.length === 1 &&
      report.candidates[0]?.toPath === anchor.path &&
      report.candidates[0].markerMatch
    ) {
      return { action: 'wait', anchorId: report.anchorId, path: anchor.path }
    }
    const reportedMarkerMatches = [...new Set(report.markerMatches)]
    if (reportedMarkerMatches.length === 1 && reportedMarkerMatches[0] === anchor.path) {
      return { action: 'wait', anchorId: report.anchorId, path: anchor.path }
    }
    if (report.candidates.length === 0) {
      const uniqueMarkerMatches = reportedMarkerMatches.filter(path => path !== anchor.path)
      if (!report.anchorPathExists && uniqueMarkerMatches.length === 1) {
        return {
          action: 'reanchor',
          anchorId: report.anchorId,
          fromPath: anchor.path,
          toPath: uniqueMarkerMatches[0]!,
          confidence: 1,
          inodeMatch: false,
          markerMatch: true,
        }
      }
      // Gone without a trace: nothing occupies the path, no inode successor
      // exists, and the marker turns up nowhere else on the drive. Every question
      // a rename could answer has come back empty.
      //
      // This is NOT `broken`, at any poll count. `broken` means Duet found
      // something it cannot identify and a human could put right; a folder that
      // is simply gone has nothing to repair, and saying "folder link needs
      // repair" about it would be offering a fix for a file the user deleted on
      // purpose. So the anchor is left exactly as it is until the drive has said
      // the same thing enough times, and then the row goes with the folder —
      // active straight to reaped, never through a repair state it would sit in
      // for a few seconds and lie the whole time.
      const traceless = !report.anchorPathExists && report.markerMatches.length === 0
      if (traceless && REAPABLE_KINDS.includes(anchor.kind)) {
        // A folder that has not arrived yet is not a folder that left. The drive
        // is right that nothing is there, and that is exactly what an install in
        // flight looks like — reaping on it deletes the agent the user just
        // picked. The install's own outcome ends the wait: landed means the
        // folder is here, failed means the row shows the error and ordinary
        // reaping resumes.
        if (anchor.arriving === true) {
          return { action: 'wait', anchorId: report.anchorId, path: anchor.path }
        }
        return report.missingIsConclusive === true ||
          report.consecutiveMissingPolls >= REAP_MISSING_POLLS
          ? {
              action: 'reap',
              anchorId: report.anchorId,
              path: anchor.path,
              kind: anchor.kind,
              consecutiveMissingPolls: report.consecutiveMissingPolls,
            }
          : { action: 'wait', anchorId: report.anchorId, path: anchor.path }
      }
      // Something IS at the path, or the marker turned up elsewhere and we could
      // not pair it. Both are genuinely unidentifiable rather than gone, which is
      // the one thing `broken` now means.
      return {
        action: 'broken',
        anchorId: report.anchorId,
        path: anchor.path,
        reason: 'no_candidate',
        candidates: report.candidates,
      }
    }
    if (report.candidates.length > 1) {
      return {
        action: 'broken',
        anchorId: report.anchorId,
        path: anchor.path,
        reason: 'ambiguous',
        candidates: report.candidates,
      }
    }

    const candidate = report.candidates[0]!
    const confidence = effectiveRenameConfidence(candidate)
    if (
      candidate.fromPath === anchor.path &&
      candidate.inodeMatch &&
      candidate.markerMatch &&
      confidence >= OBVIOUS_RENAME_CONFIDENCE
    ) {
      return {
        action: 'reanchor',
        anchorId: report.anchorId,
        fromPath: candidate.fromPath,
        toPath: candidate.toPath,
        confidence,
        inodeMatch: candidate.inodeMatch,
        markerMatch: candidate.markerMatch,
      }
    }

    return {
      action: 'broken',
      anchorId: report.anchorId,
      path: anchor.path,
      reason: 'low_confidence',
      candidates: report.candidates,
    }
  })
}

export function effectiveRenameConfidence(candidate: RenameCandidate): number {
  return Math.min(
    1,
    candidate.confidence + (candidate.inodeMatch ? INODE_MATCH_CONFIDENCE_BONUS : 0),
  )
}
