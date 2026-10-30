import { describe, expect, test } from 'bun:test'

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'

import type { WorkspaceSummary } from '@repo/contract'

import { duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import type { SpaApi } from '../context'
import {
  acceptedShareDestination,
  defaultShareMountPath,
  eligibleShareWorkspaces,
  shareRequestTitleKey,
  shareRequestCollectionState,
  shareDecisionState,
} from './recipient-requests'

const workspace = (
  id: string,
  status: WorkspaceSummary['status'],
  role: WorkspaceSummary['role'],
): WorkspaceSummary => ({
  id,
  slug: id,
  name: id,
  status,
  servicingStatus: 'active',
  role,
  billingUserId: 'user_1',
  funding: { plan: null, active: true },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
})

describe('recipient share choices', () => {
  test('a folder-page failure keeps loaded folders and retries the same cursor', async () => {
    const cursors: Array<string | undefined> = []
    let failPage = true
    const api = {
      listWorkspaceFiles: async (
        _workspaceSlug: string,
        _path: string,
        request: { cursor?: string },
      ) => {
        cursors.push(request.cursor)
        if (request.cursor === undefined) {
          return {
            items: [{ name: 'reports', path: 'reports', type: 'directory' as const }],
            nextCursor: 'folder-page-2',
          }
        }
        if (failPage) throw new Error('folder_page_failed')
        return {
          items: [{ name: 'research', path: 'research', type: 'directory' as const }],
          nextCursor: null,
        }
      },
    } as SpaApi
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    })
    const options = duetQueryOptions.workspaces.shareFolder(api, 'acme', '')
    const observer = new InfiniteQueryObserver(queryClient, options)
    try {
      await observer.refetch()
      await observer.fetchNextPage()
      await Bun.sleep(0)
      const failedResult = observer.getCurrentResult()
      expect(failedResult.isFetchNextPageError).toBe(true)
      expect(isInitialCollectionError(failedResult)).toBe(false)
      expect(failedResult.data?.items.map(item => item.path)).toEqual(['reports'])

      failPage = false
      await observer.fetchNextPage()
      expect(cursors).toEqual([undefined, 'folder-page-2', 'folder-page-2'])
      expect(observer.getCurrentResult().data?.items.map(item => item.path)).toEqual([
        'reports',
        'research',
      ])
    } finally {
      observer.destroy()
      queryClient.clear()
    }
  })

  test('projects the mount path confirmed by the server', () => {
    expect(
      acceptedShareDestination(
        { share: { mountPath: 'Shared/Finance/qbr-deck' } },
        { workspaceSlug: 'acme', mountPath: 'Shared/Finance/QBR Deck' },
      ),
    ).toEqual({
      workspaceSlug: 'acme',
      mountPath: 'Shared/Finance/qbr-deck',
    })
  })

  test('falls back to the submitted mount when the server omits it', () => {
    expect(
      acceptedShareDestination(
        { share: {} },
        { workspaceSlug: 'labs', mountPath: 'Shared/Finance/QBR Deck' },
      ),
    ).toEqual({
      workspaceSlug: 'labs',
      mountPath: 'Shared/Finance/QBR Deck',
    })
  })

  test('offers only live workspaces where the recipient can create a mount', () => {
    expect(
      eligibleShareWorkspaces([
        workspace('active-owner', 'active', 'owner'),
        workspace('active-editor', 'active', 'editor'),
        workspace('active-viewer', 'active', 'viewer'),
        workspace('retired-owner', 'retired', 'owner'),
        workspace('provisioning-owner', 'provisioning', 'owner'),
      ]).map(candidate => candidate.id),
    ).toEqual(['active-owner', 'active-editor'])
  })

  test('defaults to the selected folder plus the source folder name', () => {
    expect(defaultShareMountPath('', 'qbr-deck')).toBe('qbr-deck')
    expect(defaultShareMountPath('Shared/Finance', 'qbr-deck')).toBe('Shared/Finance/qbr-deck')
  })

  test('projects both decisions locked while accept or decline is pending', () => {
    expect(
      shareDecisionState({
        blocked: false,
        mountPath: 'Shared/qbr-deck',
        acceptPending: true,
        declinePending: false,
      }),
    ).toEqual({ locked: true, canAccept: false, canDecline: false })
    expect(
      shareDecisionState({
        blocked: false,
        mountPath: 'Shared/qbr-deck',
        acceptPending: false,
        declinePending: true,
      }),
    ).toEqual({ locked: true, canAccept: false, canDecline: false })
  })

  test('labels a partial request count as loaded rather than exact', () => {
    expect(shareRequestTitleKey(false)).toBe('title')
    expect(shareRequestTitleKey(true)).toBe('titleLoaded')
  })

  test('classifies an empty intermediate collection as incomplete for continuation', () => {
    expect(shareRequestCollectionState(0, false)).toBe('empty')
    expect(shareRequestCollectionState(0, true)).toBe('incomplete')
    expect(shareRequestCollectionState(1, true)).toBe('rows')
  })
})
