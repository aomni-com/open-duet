import {
  infiniteQueryOptions,
  mutationOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'

import type { Backup, CollectionPage } from '@repo/contract'

import type { SpaApi } from '../context'
import { duetMutationKeys, duetQueryKeys } from './query-keys'
import {
  collectionPagesQueryOptions,
  mapCollectionItems,
  prependCollectionItem,
} from './query-options'

type BackupPages = InfiniteData<CollectionPage<Backup>, string | undefined>

export function workspaceBackupsQueryOptions(
  api: Pick<SpaApi, 'listWorkspaceBackups'>,
  workspaceSlug: string,
) {
  return infiniteQueryOptions({
    ...collectionPagesQueryOptions({
      queryKey: duetQueryKeys.workspaces.backups(workspaceSlug),
      queryFn: request => api.listWorkspaceBackups(workspaceSlug, request),
      staleTime: 0,
    }),
    refetchInterval: (query: { state: { data: BackupPages | undefined } }) =>
      query.state.data?.pages.some(page =>
        page.items.some(backup => ['queued', 'running', 'deleting'].includes(backup.status)),
      )
        ? 2_000
        : false,
  })
}

export const workspaceBackupMutationOptions = {
  create: (
    api: Pick<SpaApi, 'createWorkspaceBackup'>,
    queryClient: QueryClient,
    workspaceSlug: string,
  ) =>
    mutationOptions({
      mutationKey: duetMutationKeys.workspaces.backups(workspaceSlug, 'create'),
      mutationFn: (requestId: string) => api.createWorkspaceBackup(workspaceSlug, { requestId }),
      onSuccess: ({ backup }) =>
        queryClient.setQueryData<BackupPages>(
          duetQueryKeys.workspaces.backups(workspaceSlug),
          current => {
            if (current?.pages.some(page => page.items.some(item => item.id === backup.id)))
              return mapCollectionItems(current, items =>
                items.map(item => (item.id === backup.id ? backup : item)),
              )
            return prependCollectionItem(current, backup)
          },
        ),
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: duetQueryKeys.workspaces.backups(workspaceSlug),
        }),
    }),
  download: (api: Pick<SpaApi, 'downloadWorkspaceBackup'>, workspaceSlug: string) =>
    mutationOptions({
      mutationKey: duetMutationKeys.workspaces.backups(workspaceSlug, 'download'),
      mutationFn: (backupId: string) => api.downloadWorkspaceBackup(workspaceSlug, backupId),
      gcTime: 0,
    }),
  delete: (
    api: Pick<SpaApi, 'deleteWorkspaceBackup'>,
    queryClient: QueryClient,
    workspaceSlug: string,
  ) =>
    mutationOptions({
      mutationKey: duetMutationKeys.workspaces.backups(workspaceSlug, 'delete'),
      mutationFn: (backupId: string) => api.deleteWorkspaceBackup(workspaceSlug, backupId),
      onSuccess: (result, backupId) =>
        queryClient.setQueryData<BackupPages>(
          duetQueryKeys.workspaces.backups(workspaceSlug),
          current =>
            mapCollectionItems(current, items =>
              result.deleted
                ? items.filter(item => item.id !== backupId)
                : items.map(item =>
                    item.id === backupId ? { ...item, status: 'deleting' } : item,
                  ),
            ),
        ),
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: duetQueryKeys.workspaces.backups(workspaceSlug),
        }),
    }),
}
