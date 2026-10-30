import { useQuery } from '@tanstack/react-query'

import type { App, SessionSnapshot } from '@repo/contract'

import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'

export function useSessionPaneApp(
  workspaceSlug: string,
  snapshot: SessionSnapshot | undefined,
): App | undefined {
  const { api } = useSpa()
  const cwd = snapshot?.cwd
  const appQuery = useQuery({
    ...duetQueryOptions.workspaces.appLookup(api, workspaceSlug, { cwd: cwd ?? '.' }),
    enabled: cwd !== undefined,
  })
  return appQuery.isSuccess ? appQuery.data.items[0] : undefined
}
