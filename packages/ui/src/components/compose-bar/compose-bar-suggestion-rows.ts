/**
 * Which suggestion row the keyboard may land on.
 *
 * A picker can list rows it will not insert — an agent still awaiting
 * onboarding is worth seeing and worth not delegating to. Eligibility lives
 * here, in pure functions the suggestion plugin calls, so exactly one place
 * decides it: a picker that re-checked `disabled` on click would be a second
 * owner of the same rule, and the two would eventually disagree.
 *
 * `null` means no row is eligible. That is a real state — a list of entirely
 * ineligible rows — and not the same as an empty list, so the caller has to
 * handle it rather than defaulting to row zero.
 */
type EligibleRow = { disabled?: boolean }

export function firstEligibleIndex(rows: readonly EligibleRow[]): number | null {
  const found = rows.findIndex(row => row.disabled !== true)
  return found === -1 ? null : found
}

/**
 * The next eligible row `delta` steps from `from`, wrapping past the ends.
 *
 * Wrapping is measured in eligible rows, not in list positions, so a run of
 * ineligible rows costs no keystrokes. Starting from `null` — nothing active
 * yet — the first step lands on the first eligible row in that direction.
 */
export function stepEligibleIndex(
  rows: readonly EligibleRow[],
  from: number | null,
  delta: 1 | -1,
): number | null {
  if (rows.length === 0) return null
  const start = from ?? (delta === 1 ? -1 : 0)

  for (let step = 1; step <= rows.length; step += 1) {
    const index = (start + delta * step + rows.length * step) % rows.length
    if (rows[index]?.disabled !== true) return index
  }
  return null
}

/** Whether a row exists at `index` and may be committed. */
export function isEligibleIndex(rows: readonly EligibleRow[], index: number | null): boolean {
  if (index === null) return false
  const row = rows[index]
  return row !== undefined && row.disabled !== true
}
