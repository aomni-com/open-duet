import type { AppListResponse, ListAppsQuery } from '@repo/contract'

import { duetApi, type DuetApiClient } from '../../api/client'

export interface IWorkspaceAppsSource {
  listApps(
    workspaceSlug: string,
    options?: Omit<ListAppsQuery, 'limit'> & { limit?: number; signal?: AbortSignal },
  ): Promise<AppListResponse>
}

export class RestWorkspaceAppsSource implements IWorkspaceAppsSource {
  constructor(private readonly api: Pick<DuetApiClient, 'listApps'> = duetApi) {}

  async listApps(
    workspaceSlug: string,
    options: Omit<ListAppsQuery, 'limit'> & { limit?: number; signal?: AbortSignal } = {},
  ): Promise<AppListResponse> {
    return await this.api.listApps(workspaceSlug, options)
  }
}
