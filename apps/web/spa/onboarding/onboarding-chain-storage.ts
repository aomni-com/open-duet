export type StoredOnboardingChain = { steps: readonly string[]; cursor: number }

export function chainStorageKey(workspaceId: string): string {
  return `duet.onboarding-chain:${workspaceId}`
}

export function readStoredChain(
  key: string | undefined,
  projectedSteps: readonly string[],
): StoredOnboardingChain | undefined {
  if (key === undefined || typeof window === 'undefined') return undefined
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as unknown
    if (!isStoredChain(parsed)) return undefined
    if (
      projectedSteps.length > 0 &&
      (projectedSteps.length !== parsed.steps.length ||
        projectedSteps.some((step, index) => step !== parsed.steps[index]))
    ) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function isStoredChain(value: unknown): value is StoredOnboardingChain {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.steps) &&
    candidate.steps.length > 0 &&
    candidate.steps.every(step => typeof step === 'string') &&
    Number.isInteger(candidate.cursor) &&
    (candidate.cursor as number) >= 0 &&
    (candidate.cursor as number) <= candidate.steps.length
  )
}

export function writeStoredChain(key: string, steps: readonly string[], cursor: number): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(
    key,
    JSON.stringify({ steps, cursor } satisfies StoredOnboardingChain),
  )
}
