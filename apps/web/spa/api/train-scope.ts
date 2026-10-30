export type TrainScope = { kind: 'root' } | { kind: 'agent'; agentSlug: string }

export const ROOT_TRAIN_SCOPE = { kind: 'root' } as const satisfies TrainScope

export function trainPath(workspaceSlug: string, scope: TrainScope): string {
  const workspacePath = `/api/duet/ws/${encodeURIComponent(workspaceSlug)}`
  return scope.kind === 'root'
    ? `${workspacePath}/train`
    : `${workspacePath}/agents/${encodeURIComponent(scope.agentSlug)}/train`
}

/**
 * A link to the bytes the training archive kept for one source.
 *
 * `relPath` is a path *sequence* — an archive preserves the corpus's folder
 * structure — so each segment is encoded separately; encoding it whole would
 * turn its separators into `%2F` and miss the route.
 */
export function trainRecordSourceUrl(
  workspaceSlug: string,
  scope: TrainScope,
  slug: string,
  relPath: string,
): string {
  const encodedRelPath = relPath.split('/').map(encodeURIComponent).join('/')
  return `${trainPath(workspaceSlug, scope)}/records/${encodeURIComponent(slug)}/sources/${encodedRelPath}`
}

export function trainScopeKey(scope: TrainScope): readonly [] | readonly ['agent', string] {
  return scope.kind === 'root' ? [] : ['agent', scope.agentSlug]
}
