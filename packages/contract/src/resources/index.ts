import type { SubscriptionPlanId } from '../plans/index'

export type WorkspaceVmCaps =
  | { readonly cpu: 4; readonly memory: '8GB' }
  | { readonly cpu: 8; readonly memory: '16GB' }
  | { readonly cpu: 10; readonly memory: '24GB' }

/** What a workspace with no live subscription gets, and the floor every VM starts at. */
const STANDARD_WORKSPACE_VM_CAPS = { cpu: 4, memory: '8GB' } as const

// Keyed by plan rather than branched on, so adding a plan fails to compile
// until it has been sized — a fall-through would quietly hand a new paid tier
// the free floor, which is invisible until a customer complains about a slow VM.
//
// Max is 10 cores, not the 12 it wants: exe.dev refuses any VM wider than the
// reserved pool it lives in, and `pool-duet` is 10 wide today, so asking for 12
// fails the create outright (HTTP 422, "--cpu cannot exceed 10, the size of
// pool") rather than merely running slower. Memory is not pool-constrained.
// Raise this once support@exe.dev grows the pool; re-measure first with
// `packages/exe/scripts/probe-vm-caps.ts`, which on 2026-08-07 scheduled 4/8,
// 8/16 and 10/24 in-pool and was rejected at 12/24.
const WORKSPACE_VM_CAPS_BY_PLAN = {
  starter: STANDARD_WORKSPACE_VM_CAPS,
  pro: { cpu: 8, memory: '16GB' },
  max: { cpu: 10, memory: '24GB' },
} as const satisfies Record<SubscriptionPlanId, WorkspaceVmCaps>

export const WORKSPACE_VM_POOL = 'pool-duet'

/** Free and $20 Starter workspaces use 4/8; Pro uses 8/16; Max uses 10/24. */
export function workspaceVmCapsForPlan(plan: SubscriptionPlanId | undefined): WorkspaceVmCaps {
  return plan === undefined ? STANDARD_WORKSPACE_VM_CAPS : WORKSPACE_VM_CAPS_BY_PLAN[plan]
}

// Provider-side identity of a workspace VM. Every workspace VM carries
// WORKSPACE_VM_TAG; one exe.dev account backs BOTH staging and prod, and the
// VM name is an opaque `duet-ws-<sha256(workspaceId)[:24]>`, so tags are the
// only thing distinguishing VMs on the provider side.
export const WORKSPACE_VM_TAG = 'duet-workspace'

// Marks a VM whose workspace was EXPLICITLY minted as disposable — login-as
// with the `ephemeral` option (6h default lifetime, 24h cap, erased by the
// expiry cron). Never inferred from how a user was created, so login-as can
// also mint real customers. A sweep keyed on this tag
// (`packages/exe/scripts/sweep-ephemeral-vms.ts`) can delete throwaway VMs
// without cross-referencing two Convex deployments, where a mistake deletes a
// real user's drive. Shared here because the writer (convex
// `workspaces/vmTags.ts`) and the sweeper live in different packages.
export const EPHEMERAL_VM_TAG = 'duet-ephemeral'

// Which environment a VM belongs to. Derived from the control plane the VM was
// told to phone home to (`workspaceVmTags`), never configured: a VM reporting
// to production IS a production VM, so the tag cannot drift from reality the
// way a hand-set env var can. A host that matches neither origin is left
// untagged — the same never-swept default as an absent EPHEMERAL_VM_TAG,
// because the destructive tool here is a sweep and an unplaceable VM must not
// look like it belongs to the environment being cleaned.
export const PRODUCTION_VM_TAG = 'duet-production'
export const STAGING_VM_TAG = 'duet-staging'
export const STAGING_API_ORIGIN = 'https://ctl-staging.duet.so'
