import { isDrivePathWithin, type RenameCandidate } from '@repo/contract'

export type ShareAnchorTransition =
  | { kind: 'relocate'; toPath: string }
  | { kind: 'unlink' }
  | { kind: 'unchanged' }

export interface ShareAnchorTransitionEvidence {
  anchorPath: string
  anchorPathExists: boolean
  consecutiveMissingPolls: number
  candidates: RenameCandidate[]
  markerMatches: string[]
  linkedPaths: string[]
  targetConflict: boolean
  missingIsConclusive?: boolean
}

export function resolveShareAnchorTransition(
  evidence: ShareAnchorTransitionEvidence,
): ShareAnchorTransition {
  if (evidence.targetConflict) return { kind: 'unlink' }
  const reportedMarkerMatches = [...new Set(evidence.markerMatches)]
  if (reportedMarkerMatches.length === 1 && reportedMarkerMatches[0] === evidence.anchorPath) {
    return { kind: 'unchanged' }
  }
  if (evidence.anchorPathExists) {
    return evidence.consecutiveMissingPolls >= 2 ? { kind: 'unlink' } : { kind: 'unchanged' }
  }

  const markerMatches = reportedMarkerMatches.filter(path => path !== evidence.anchorPath)
  if (markerMatches.length > 1) return { kind: 'unlink' }

  const inodeCandidates = evidence.candidates.filter(
    candidate =>
      candidate.fromPath === evidence.anchorPath &&
      candidate.toPath !== evidence.anchorPath &&
      candidate.inodeMatch &&
      candidate.markerMatch,
  )
  if (inodeCandidates.length > 1) return { kind: 'unlink' }

  const markerPath = markerMatches[0]
  const inodePath = inodeCandidates[0]?.toPath
  if (markerPath !== undefined && inodePath !== undefined && markerPath !== inodePath) {
    return { kind: 'unlink' }
  }
  const toPath = markerPath ?? inodePath
  if (toPath !== undefined) {
    if (
      evidence.linkedPaths.some(
        path => isDrivePathWithin(path, toPath) || isDrivePathWithin(toPath, path),
      )
    ) {
      return { kind: 'unlink' }
    }
    return { kind: 'relocate', toPath }
  }

  return evidence.missingIsConclusive === true || evidence.consecutiveMissingPolls >= 2
    ? { kind: 'unlink' }
    : { kind: 'unchanged' }
}
