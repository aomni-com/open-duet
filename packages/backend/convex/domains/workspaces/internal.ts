import type { GenericMutationCtx } from 'convex/server'

import { MAX_SLUG_LENGTH, assertValidSlug } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { writeAuditEvent } from '../audit/model'
import { auditActor } from './provisioningShared'

type MutationCtx = GenericMutationCtx<DataModel>
// Only `deleted` frees a slug. Archived rows resume under their own slug on
// renewal, so a workspace born under one would collide the day its owner
// resubscribes.
const UNAVAILABLE_WORKSPACE_STATUSES = [
  'provisioning',
  'active',
  'unhealthy',
  'archived',
  'retired',
] as const

export async function requireAvailableWorkspaceSlug(
  ctx: MutationCtx,
  slug: string,
  excludeWorkspaceId?: Id<'workspaces'>,
): Promise<string> {
  assertValidSlug(slug, 'workspace')
  for (const status of UNAVAILABLE_WORKSPACE_STATUSES) {
    const match = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', slug).eq('status', status))
      .first()
    if (match !== null && match._id !== excludeWorkspaceId) {
      throw new Error('Workspace slug is already taken')
    }
  }
  return slug
}

export async function findAvailableWorkspaceSlug(
  ctx: MutationCtx,
  rawBase: string,
): Promise<string> {
  const base = trimSlugBase(rawBase)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`.replace(
      /-+$/g,
      '',
    )
    try {
      await requireAvailableWorkspaceSlug(ctx, candidate)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('Could not allocate workspace slug')
}

function trimSlugBase(rawBase: string): string {
  const base = rawBase.replace(/-+$/g, '') || 'workspace'
  return base.length > MAX_SLUG_LENGTH ? base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') : base
}

/**
 * Move an archived workspace off a slug a live workspace also holds.
 *
 * Until `archived` counted as taking a slug, a signup could be born under an
 * archived workspace's slug. The live row is the one its owner is using
 * today, so it keeps the slug; the archived row takes the next free suffix
 * and records the rename.
 */
export async function reslugArchivedWorkspaceCollision(
  ctx: MutationCtx,
  workspace: Doc<'workspaces'>,
): Promise<void> {
  if (workspace.status !== 'archived') return
  let live = false
  for (const status of ['provisioning', 'active', 'unhealthy'] as const) {
    const holder = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', workspace.slug).eq('status', status))
      .first()
    if (holder !== null) live = true
  }
  if (!live) return
  const now = Date.now()
  const slug = await findAvailableWorkspaceSlug(ctx, workspace.slug)
  await ctx.db.patch(workspace._id, { slug, updatedAt: now })
  await writeAuditEvent(ctx, {
    workspaceId: workspace._id,
    event: 'workspace.renamed',
    actorId: auditActor(workspace),
    at: now,
    provenance: { oldSlug: workspace.slug, newSlug: slug, reason: 'archived_slug_collision' },
  })
}
