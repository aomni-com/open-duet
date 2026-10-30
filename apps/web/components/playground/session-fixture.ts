import type { SessionSummary } from '@repo/contract'

type SessionProjectionFields = Pick<SessionSummary, 'audience' | 'archive' | 'permissions'>

export function workspaceSessionProjection(): SessionProjectionFields {
  return {
    audience: { kind: 'workspace' },
    archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
    permissions: {
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: false,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    },
  }
}
