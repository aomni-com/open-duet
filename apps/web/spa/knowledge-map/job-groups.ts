import { SESSION_ACTIVITY_PRIORITY } from '@repo/contract'

import type { Job } from './types'

/**
 * The five-seat map summary retains completed history after every unfinished
 * row. Stable sorting preserves the wire's newest-first order inside a bucket.
 */
export function seatedJobs(jobs: readonly Job[]): readonly Job[] {
  return jobs
    .slice()
    .sort(
      (left, right) =>
        SESSION_ACTIVITY_PRIORITY.indexOf(left.state) -
        SESSION_ACTIVITY_PRIORITY.indexOf(right.state),
    )
}
