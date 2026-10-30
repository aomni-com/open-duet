import { DuetApiError } from './api/client'

export type WorkspaceRefusalCopyKey = 'paused' | 'provisioning' | 'unhealthy' | 'archived'

const COPY_BY_CODE: Record<string, WorkspaceRefusalCopyKey> = {
  workspace_paused: 'paused',
  workspace_provisioning: 'provisioning',
  workspace_unhealthy: 'unhealthy',
  workspace_archived: 'archived',
}

export function workspaceRefusalCopyKey(error: unknown): WorkspaceRefusalCopyKey | null {
  if (!(error instanceof DuetApiError)) return null
  return COPY_BY_CODE[error.code] ?? null
}
