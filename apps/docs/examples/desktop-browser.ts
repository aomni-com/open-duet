import type {
  DesktopFocusResult,
  DesktopFetch,
  DesktopScreen,
  DesktopSession,
  DesktopStatus,
} from './desktop-contract'

export const DESKTOP_IFRAME_SANDBOX =
  'allow-same-origin allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads'
export const DESKTOP_IFRAME_ALLOW = 'clipboard-read; clipboard-write'
export const DESKTOP_IFRAME_REFERRER_POLICY = 'no-referrer'
export const DESKTOP_IFRAME_ALLOW_FULLSCREEN = true

export function createDesktopBrowserApi(fetchImpl: DesktopFetch = fetch) {
  return {
    mint: (embedOrigin: string) =>
      requestJson<DesktopSession>(fetchImpl, '/api/desktop/session', {
        method: 'POST',
        body: JSON.stringify({ embedOrigin }),
      }),
    status: () => requestJson<DesktopStatus>(fetchImpl, '/api/desktop/status'),
    focus: (agentSlug: string, requestId: string) =>
      requestJson<DesktopFocusResult>(fetchImpl, '/api/desktop/focus', {
        method: 'POST',
        body: JSON.stringify({ agentSlug, requestId }),
      }),
  }
}

/** Mint once on mount, remint after an actual reconnect, and poll status separately. */
export async function mountDesktop(
  container: HTMLElement,
  options: {
    onStatus?(status: DesktopStatus): void
    onError?(error: unknown): void
    statusIntervalMs?: number
  } = {},
) {
  const api = createDesktopBrowserApi()
  const iframe = document.createElement('iframe')
  iframe.title = 'Workspace desktop'
  iframe.referrerPolicy = DESKTOP_IFRAME_REFERRER_POLICY
  iframe.sandbox.value = DESKTOP_IFRAME_SANDBOX
  iframe.allow = DESKTOP_IFRAME_ALLOW
  iframe.allowFullscreen = DESKTOP_IFRAME_ALLOW_FULLSCREEN
  iframe.style.position = 'absolute'
  iframe.style.border = '0'
  iframe.style.transformOrigin = 'top left'

  container.style.position = 'relative'
  container.style.overflow = 'hidden'
  container.style.background = 'black'
  container.replaceChildren(iframe)

  let screen: DesktopScreen = { width: 1440, height: 900 }
  let disposed = false
  let reconnecting: Promise<void> | null = null

  const layout = () => {
    const rect = fitDesktop(
      { width: container.clientWidth, height: container.clientHeight },
      screen,
    )
    iframe.width = String(screen.width)
    iframe.height = String(screen.height)
    iframe.style.left = `${rect.left}px`
    iframe.style.top = `${rect.top}px`
    iframe.style.transform = `scale(${rect.scale})`
  }
  const reconnect = () => {
    if (reconnecting !== null) return reconnecting
    reconnecting = api
      .mint(window.location.origin)
      .then(session => {
        if (disposed) return
        screen = session.screen
        iframe.src = session.entryUrl
        layout()
      })
      .finally(() => {
        reconnecting = null
      })
    return reconnecting
  }
  const refreshStatus = async () => {
    const status = await api.status()
    options.onStatus?.(status)
    return status
  }
  const focus = (agentSlug: string, requestId: string) => api.focus(agentSlug, requestId)
  const reportError = (error: unknown) => options.onError?.(error)
  const reconnectWhenOnline = () => void reconnect().catch(reportError)

  await reconnect()
  const resizeObserver = new ResizeObserver(layout)
  resizeObserver.observe(container)
  const statusTimer = window.setInterval(() => {
    void refreshStatus().catch(reportError)
  }, options.statusIntervalMs ?? 5_000)
  window.addEventListener('online', reconnectWhenOnline)

  return {
    reconnect,
    refreshStatus,
    focus,
    dispose() {
      disposed = true
      resizeObserver.disconnect()
      window.clearInterval(statusTimer)
      window.removeEventListener('online', reconnectWhenOnline)
      iframe.remove()
    },
  }
}

export function fitDesktop(container: { width: number; height: number }, screen: DesktopScreen) {
  const scale = Math.min(1, container.width / screen.width, container.height / screen.height)
  const width = screen.width * scale
  const height = screen.height * scale
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
    scale,
  }
}

async function requestJson<T>(
  fetchImpl: DesktopFetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(path, {
    ...init,
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
  })
  if (!response.ok) {
    const error = new Error(`Desktop request failed: ${response.status}`)
    Object.assign(error, { response })
    throw error
  }
  return (await response.json()) as T
}
