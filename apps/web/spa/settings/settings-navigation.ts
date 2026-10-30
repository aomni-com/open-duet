export type SettingsNavigationState = { settingsReturnTo: string }

export function settingsNavigationState(pathname: string, search = ''): SettingsNavigationState {
  return { settingsReturnTo: `${pathname}${search}` }
}

export function settingsReturnDestination(
  state: unknown,
  workspaceSlug: string | undefined,
): string {
  const fallback =
    workspaceSlug === undefined ? '/' : `/w/${encodeURIComponent(workspaceSlug)}/home`
  if (!isSettingsNavigationState(state)) return fallback
  const target = state.settingsReturnTo
  if (!target.startsWith('/') || target.startsWith('//')) return fallback
  if (target === '/settings' || target.startsWith('/settings/')) return fallback
  if (/^\/w\/[^/]+\/settings(?:\/|$)/.test(target)) return fallback
  return target
}

function isSettingsNavigationState(value: unknown): value is SettingsNavigationState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'settingsReturnTo' in value &&
    typeof value.settingsReturnTo === 'string'
  )
}
