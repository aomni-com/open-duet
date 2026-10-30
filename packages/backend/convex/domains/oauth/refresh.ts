export const REFRESH_GRACE_MS = 30_000

export interface RefreshFamily {
  generation: number
  headHash: string
  predecessorHash?: string
  predecessorGraceUntil?: number
}

export type RefreshTransition =
  | {
      outcome: 'rotated'
      generation: number
      predecessorGraceUntil: number
    }
  | {
      outcome: 'graceRerotate'
      generation: number
      predecessorGraceUntil: number
    }
  | {
      outcome: 'familyRevoked'
      generation: number
    }

export function transitionRefreshFamily(
  family: RefreshFamily,
  presentedHash: string,
  now: number,
): RefreshTransition {
  if (presentedHash === family.headHash) {
    return {
      outcome: 'rotated',
      generation: family.generation + 1,
      predecessorGraceUntil: now + REFRESH_GRACE_MS,
    }
  }
  if (
    presentedHash === family.predecessorHash &&
    family.predecessorGraceUntil !== undefined &&
    now <= family.predecessorGraceUntil
  ) {
    return {
      outcome: 'graceRerotate',
      generation: family.generation,
      predecessorGraceUntil: family.predecessorGraceUntil,
    }
  }
  return { outcome: 'familyRevoked', generation: family.generation }
}
