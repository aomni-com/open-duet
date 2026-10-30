import {
  DUET_API_ORIGIN,
  EPHEMERAL_VM_TAG,
  PRODUCTION_VM_TAG,
  STAGING_API_ORIGIN,
  STAGING_VM_TAG,
  WORKSPACE_VM_TAG,
} from '@repo/contract'

import { type Env, exeVmTags } from '../../config'

/**
 * The single owner of what tags a workspace VM carries. Inline tag arrays at
 * the create call sites would drift apart, and this one is load-bearing for a
 * destructive sweep.
 */
export function workspaceVmTags(
  workspace: { ephemeral?: boolean | undefined },
  env: Env = process.env,
  apiUrl?: string,
): string[] {
  // Strict `=== true`: a sweep keyed on this tag removes drives, so anything
  // other than an explicit yes must fall through to the untagged, never-swept
  // case.
  return [
    WORKSPACE_VM_TAG,
    ...(workspace.ephemeral === true ? [EPHEMERAL_VM_TAG] : []),
    ...environmentTag(apiUrl),
    ...exeVmTags(env),
  ]
}

/**
 * The environment a VM belongs to is whichever control plane it reports to, so
 * the tag is read off that URL rather than configured beside it. An unknown
 * host yields no tag: an environment-scoped sweep must never see a VM it
 * cannot place.
 */
function environmentTag(apiUrl: string | undefined): string[] {
  if (apiUrl === undefined) return []
  let origin: string
  try {
    origin = new URL(apiUrl).origin
  } catch {
    return []
  }
  if (origin === DUET_API_ORIGIN) return [PRODUCTION_VM_TAG]
  if (origin === STAGING_API_ORIGIN) return [STAGING_VM_TAG]
  return []
}
