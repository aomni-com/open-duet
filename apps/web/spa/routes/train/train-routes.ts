/* ============================================================================
   Where a Train scope lives, and what a memory under it is called.

   Train stays one control centre with the roster down its left side — the
   shipped decision — so these paths do not open separate pages. They say which
   row of that picker is selected, and a memory says which row owns it.

   ---- every scope is a slug, the drive's own included ----
   Root used to be the *absence* of one: `computer/train`, bare. That made it
   the single row in the rail whose selection no link could express, and it
   forced a static `agents/` segment between the two shapes underneath —
   `train/support-handbook` (a root memory) and `train/agents/research` (an
   agent) are otherwise the same shape and would collide.

   Naming root removes both problems with one segment. The grammar becomes a
   mirror of `/agents/:agentSlug`, and it spends the same reserved token: `root`
   is what the contract calls the drive's own scope (`ROOT_AGENT_SCOPE`), what
   `/agents/root` unfolds, and what the session alias resolves. No agent can
   take it, so `train/:agentSlug` needs no disambiguator.
   ========================================================================= */
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { TrainScope } from '../../api/train-scope'

/** The scope's own segment. The drive's is a real word, not an empty one. */
function scopeSegment(scope: TrainScope): string {
  return encodeURIComponent(scope.kind === 'root' ? ROOT_AGENT_SCOPE : scope.agentSlug)
}

export function trainPath(workspaceSlug: string, scope: TrainScope): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/train/${scopeSegment(scope)}`
}

export function trainRecordPath(workspaceSlug: string, scope: TrainScope, slug: string): string {
  return `${trainPath(workspaceSlug, scope)}/${encodeURIComponent(slug)}`
}

export function legacyTrainRecordRedirectPath(
  workspaceSlug: string,
  scope: TrainScope,
  searchParams: URLSearchParams,
): string | undefined {
  const slug = searchParams.get('record')
  return slug ? trainRecordPath(workspaceSlug, scope, slug) : undefined
}

export function legacyAgentTrainRedirectPath(
  workspaceSlug: string,
  agentSlug: string,
  memorySlug: string | undefined,
  searchParams: URLSearchParams,
): string {
  const scope = { kind: 'agent', agentSlug } as const
  const recordSlug = memorySlug ?? searchParams.get('record') ?? undefined
  return recordSlug === undefined
    ? trainPath(workspaceSlug, scope)
    : trainRecordPath(workspaceSlug, scope, recordSlug)
}

/* ---- retrain ----

   A retrain says "train, but replace this memory instead of making another".
   That target has to outlive the click: the Train button is relabeled "Retry
   training" after a failure rather than being a second control, so state
   scoped to one submit would be gone exactly when the user retries.

   The URL holds it. The cost of that choice is that it also survives success —
   a bookmark or a back-button return would otherwise silently overwrite a
   memory weeks later — so the page shows a banner naming the target for as
   long as the parameter is set, and drops it when the job completes. */

const RETRAIN_PARAM = 'retrain'

export function retrainTargetFromSearch(searchParams: URLSearchParams): string | undefined {
  const slug = searchParams.get(RETRAIN_PARAM)
  return slug ? slug : undefined
}

export function retrainTrainPath(
  workspaceSlug: string,
  scope: TrainScope,
  recordSlug: string,
): string {
  const search = new URLSearchParams({ [RETRAIN_PARAM]: recordSlug })
  return `${trainPath(workspaceSlug, scope)}?${search.toString()}`
}

/** The same page with the retrain target dropped — Cancel, and job completion. */
export function trainPathWithoutRetrain(
  workspaceSlug: string,
  scope: TrainScope,
  searchParams: URLSearchParams,
): string {
  const next = new URLSearchParams(searchParams)
  next.delete(RETRAIN_PARAM)
  const search = next.toString()
  return search.length === 0
    ? trainPath(workspaceSlug, scope)
    : `${trainPath(workspaceSlug, scope)}?${search}`
}
