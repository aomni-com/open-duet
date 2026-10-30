import {
  isCollectionCursorError,
  WorkspaceSkillsListQuerySchema,
  WorkspaceSkillsPageSchema,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import { requireAuthedWorkspace, type ApiApp, type ApiRouteRuntime } from '../shared'

const skillPages = createMaterializedCollectionPage('skills.list')

/**
 * What skills a workspace can run, read straight from its VM.
 *
 * Skills are files on the drive: a person can install, edit, or delete one
 * without the control plane hearing about it, so mirroring the list into the
 * backend would only be a promise to go stale. This route is read when someone
 * opens a picker, and it carries no state of its own.
 *
 * `cwd` is the drive-relative folder the reader means — an agent's anchor, or
 * absent for the drive root — because a skill installed under one agent belongs
 * to that agent and must not appear for another.
 */
export function registerSkillsRoutes(
  app: ApiApp,
  _runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/skills', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const query = WorkspaceSkillsListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)

    const result = await gatewayClient.listSkills(workspace.slug, query.data.cwd)
    if (result instanceof Response) return result
    const ordered = [...result.skills].sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    )
    try {
      const page = await skillPages.response(
        query.data,
        {
          subject: `workspace:${workspace.id}`,
          filters: { cwd: query.data.cwd ?? null },
          order: 'name asc, path asc',
        },
        ordered,
        skill => [skill.name, skill.path],
      )
      return c.json(WorkspaceSkillsPageSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })
}
