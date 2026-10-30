import type { Backup } from '@repo/contract'

import type { SpaApi } from '../../spa/context'

export const BACKUP_FIXTURE_STATES = [
  'empty',
  'capturing',
  'uploading',
  'ready',
  'partial',
  'failed',
  'deleting',
  'archived',
] as const
export type BackupFixtureState = (typeof BACKUP_FIXTURE_STATES)[number]

export function createBackupFixture(
  state: BackupFixtureState = 'empty',
  record: (event: unknown) => void = () => {},
) {
  let nextId = 1
  let loseNextResponse = false
  let downloadCount = 0
  const requests = new Map<string, Backup>()
  let items: Backup[] = state === 'empty' ? [] : [makeBackup(state, 'backup-1')]
  return {
    advance(next: BackupFixtureState) {
      if (next === 'empty') items = []
      else
        items = [
          {
            ...makeBackup(next, items[0]?.id ?? 'backup-1'),
            createdAt: items[0]?.createdAt ?? Date.UTC(2026, 6, 11, 9),
          },
        ]
    },
    finishDeletion() {
      items = items.filter(item => item.status !== 'deleting')
    },
    loseNextResponse() {
      loseNextResponse = true
    },
    api: {
      listWorkspaceBackups: async () => ({ items: structuredClone(items), nextCursor: null }),
      getWorkspaceBackup: async (_workspaceSlug, backupId) => ({
        backup: structuredClone(items.find(item => item.id === backupId)!),
      }),
      createWorkspaceBackup: async (_workspaceSlug, input) => {
        const existing = requests.get(input.requestId)
        const backup = existing ?? {
          ...makeBackup('capturing', `backup-created-${nextId++}`),
          status: 'queued' as const,
          phase: undefined,
          progress: {
            processedFiles: 0,
            processedRecords: 0,
            capturedBytes: 0,
            uploadedBytes: 0,
            warningCount: 0,
            warningSummary: [],
          },
        }
        if (!existing) {
          requests.set(input.requestId, backup)
          items = [backup, ...items]
        }
        record({
          kind: 'create',
          requestId: input.requestId,
          backupId: backup.id,
          created: !existing,
        })
        if (loseNextResponse) {
          loseNextResponse = false
          throw new TypeError('Fixture response lost')
        }
        return { backup: structuredClone(backup) }
      },
      downloadWorkspaceBackup: async (_workspaceSlug, backupId) => {
        downloadCount++
        record({ kind: 'download', backupId, count: downloadCount })
        return {
          url: new URL(
            `/playground/backup-download.zip?grant=${downloadCount}`,
            window.location.origin,
          ).href,
          expiresAt: Date.UTC(2026, 6, 11, 10),
          filename: 'acme-workspace.zip',
          bytes: 84_500_000,
          sha256: 'a'.repeat(64),
        }
      },
      deleteWorkspaceBackup: async (_workspaceSlug, backupId) => {
        const existed = items.some(item => item.id === backupId)
        items = items.map(item => (item.id === backupId ? { ...item, status: 'deleting' } : item))
        record({ kind: 'delete', backupId })
        return { deleted: !existed, emptyDriveOnNextStart: state === 'archived' }
      },
    } satisfies Pick<
      SpaApi,
      | 'listWorkspaceBackups'
      | 'getWorkspaceBackup'
      | 'createWorkspaceBackup'
      | 'downloadWorkspaceBackup'
      | 'deleteWorkspaceBackup'
    >,
  }
}

function makeBackup(state: Exclude<BackupFixtureState, 'empty'>, id: string): Backup {
  const ready = state === 'ready' || state === 'partial' || state === 'archived'
  return {
    id,
    workspaceId: 'workspace_acme',
    purpose: state === 'archived' ? 'archive' : 'export',
    status: ready
      ? 'ready'
      : state === 'failed'
        ? 'failed'
        : state === 'deleting'
          ? 'deleting'
          : 'running',
    ...(state === 'capturing'
      ? { phase: 'files' as const }
      : state === 'uploading'
        ? { phase: 'upload' as const }
        : {}),
    createdAt: Date.UTC(2026, 6, 11, 9),
    updatedAt: Date.UTC(2026, 6, 11, 9, 4),
    progress: {
      processedFiles: 482,
      processedRecords: 12_640,
      capturedBytes: 84_500_000,
      uploadedBytes: state === 'capturing' ? 0 : state === 'uploading' ? 43_000_000 : 84_500_000,
      warningCount: state === 'partial' ? 3 : 0,
      warningSummary: state === 'partial' ? [{ code: 'missing_image', count: 3 }] : [],
    },
    ...(ready
      ? {
          completeness: state === 'partial' ? ('partial' as const) : ('complete' as const),
          bytes: 84_500_000,
          sha256: 'a'.repeat(64),
          completedAt: Date.UTC(2026, 6, 11, 9, 4),
        }
      : {}),
    ...(state === 'failed'
      ? { error: { code: 'upload_failed' as const, message: 'Upload did not finish' } }
      : {}),
  }
}
