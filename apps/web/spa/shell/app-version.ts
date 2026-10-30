import type { ToastInput } from './toast'

export type AppUpdateTranslator = (key: 'message' | 'description' | 'action') => string

export function appUpdateToast(t: AppUpdateTranslator, reload: () => void): ToastInput {
  return {
    message: t('message'),
    description: t('description'),
    tone: 'info',
    persist: true,
    action: { label: t('action'), onClick: reload },
  }
}

/** What this tab believes it is running, and whether it has already said so. */
export type VersionWatch = {
  readonly loaded: string | undefined
  readonly announced: boolean
}

export const INITIAL_VERSION_WATCH: VersionWatch = { loaded: undefined, announced: false }

/**
 * Fold one probe answer into the watch.
 *
 * The first answer only establishes the baseline — a tab that has just loaded
 * is by definition current, whatever the origin reports. After that, any
 * disagreement means the origin has moved on, and the tab is told exactly once:
 * the notice is persistent, so repeating it for every later promotion would
 * stack notices about a fact the user already has.
 */
export function advanceVersionWatch(
  watch: VersionWatch,
  observed: string | null,
): { watch: VersionWatch; shouldNotify: boolean } {
  if (observed === null) return { watch, shouldNotify: false }
  if (watch.loaded === undefined)
    return { watch: { ...watch, loaded: observed }, shouldNotify: false }
  if (watch.loaded === observed || watch.announced) return { watch, shouldNotify: false }
  return { watch: { ...watch, announced: true }, shouldNotify: true }
}

/** Ask this origin which deployment is serving it, or `null` if it cannot say. */
export async function probeAppVersion(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch('/api/version', { cache: 'no-store', signal })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' && body.version.length > 0 ? body.version : null
  } catch {
    return null
  }
}
