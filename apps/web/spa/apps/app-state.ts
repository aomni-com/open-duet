import type { InfiniteData } from '@tanstack/react-query'

import type { App, AppListResponse, AppVisibility } from '@repo/contract'

import { mapCollectionItems } from '../api/query-options'

/* The cached app list, edited the three ways the app menu edits it. Pure, and
   apart from the menu, because an optimistic write and the write that lands
   have to agree about what the list looks like afterwards. */

export function withAppVisibility(
  current: InfiniteData<AppListResponse> | undefined,
  slug: string,
  visibility: AppVisibility,
): InfiniteData<AppListResponse> | undefined {
  return mapCollectionItems(current, items =>
    items.map(app => (app.slug === slug ? { ...app, visibility } : app)),
  )
}

export function replaceApp(current: InfiniteData<AppListResponse> | undefined, app: App) {
  return mapCollectionItems(current, items =>
    items.map(candidate => (candidate.id === app.id ? app : candidate)),
  )
}

export function withoutApp(current: InfiniteData<AppListResponse> | undefined, slug: string) {
  return mapCollectionItems(current, items => items.filter(app => app.slug !== slug))
}
