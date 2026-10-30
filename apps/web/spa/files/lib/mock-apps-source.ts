import type { AppListResponse } from '@repo/contract'

import type { IWorkspaceAppsSource } from './apps-source'

export class MockWorkspaceAppsSource implements IWorkspaceAppsSource {
  private readonly responses = new Map<string, AppListResponse>()

  seed(workspaceSlug: string, response: AppListResponse): void {
    this.responses.set(workspaceSlug, response)
  }

  async listApps(workspaceSlug: string): Promise<AppListResponse> {
    const response = this.responses.get(workspaceSlug)
    if (response === undefined) throw new Error(`workspace_apps_fixture_missing:${workspaceSlug}`)
    return response
  }

  deleteApp(workspaceSlug: string, appSlug: string): void {
    const response = this.responses.get(workspaceSlug)
    if (response === undefined) throw new Error(`workspace_apps_fixture_missing:${workspaceSlug}`)
    this.responses.set(workspaceSlug, {
      ...response,
      items: response.items.filter(app => app.slug !== appSlug),
    })
  }
}
