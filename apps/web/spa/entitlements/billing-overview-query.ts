import type { UserBillingOverview } from '@repo/contract'

import { DuetApiError } from '../api/client'

type BillingOverviewApi = {
  userBilling(signal?: AbortSignal): Promise<UserBillingOverview>
}

export function billingOverviewQueryBehavior(api: BillingOverviewApi, pollMs: number | false) {
  const queryFn = async ({ signal }: { signal: AbortSignal }) => {
    try {
      return await api.userBilling(signal)
    } catch (error) {
      if (isBillingOverviewUnavailable(error)) return null
      throw error
    }
  }
  const retry = (failureCount: number, error: Error) =>
    failureCount < 2 && !isBillingOverviewUnavailable(error)
  const refetchInterval = (query: {
    state: { status?: string; data?: UserBillingOverview | null }
  }) => (query.state.status === 'success' && query.state.data === null ? false : pollMs)
  return {
    queryFn,
    retry,
    refetchInterval,
  }
}

function isBillingOverviewUnavailable(error: unknown): boolean {
  return error instanceof DuetApiError && (error.status === 401 || error.status === 403)
}
