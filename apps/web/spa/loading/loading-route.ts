import { mapDestinationOf } from '../drive/agents-map-url'
import { workPresentationForPath } from '../team-space/work-destination'

export type ProductLoadingView =
  | 'work-home'
  | 'work-session'
  | 'work-app'
  | 'agents-map'
  | 'agent-page'
  | 'marketplace'
  | 'marketplace-detail'
  | 'agent-detail'
  | 'files'
  | 'train'
  | 'integrations'
  | 'settings'
  | 'generic'

export type WorkLoadingView = Extract<ProductLoadingView, `work-${string}`>

export function isWorkLoadingView(view: ProductLoadingView): view is WorkLoadingView {
  return view.startsWith('work-')
}

/**
 * One browser-location-to-loading-owner contract shared by the server fallback,
 * identity bootstrap, lazy route boundary, and destination data boundary.
 * The query is part of the input because app paths use it to
 * preserve Work presentation without inventing a second entity URL.
 */
export function loadingViewForPath(path: string): ProductLoadingView {
  const location = new URL(path, 'https://duet.local')
  const segments = location.pathname.split('/').filter(Boolean)

  if (segments.length === 0) return 'work-home'
  if (segments[0] === 'w' && segments[1] !== undefined) {
    let workspaceSlug: string
    try {
      workspaceSlug = decodeURIComponent(segments[1])
    } catch {
      return 'generic'
    }
    const work = workPresentationForPath(location.pathname, workspaceSlug, location.search)
    if (work.kind !== 'build') {
      return work.kind === 'home'
        ? 'work-home'
        : work.kind === 'session'
          ? 'work-session'
          : 'work-app'
    }
  }

  /* The grammar chooses the destination frame: agent pages need their own
     skeleton, while the graph needs the map skeleton. */
  const map = mapDestinationOf(location.pathname)
  if (map !== null) return map === 'graph' ? 'agents-map' : 'agent-page'

  if (segments[0] === 'settings') return 'settings'
  if (segments[0] !== 'w') return 'generic'

  const destination = segments[2]
  /* `/agents` is the drive's map of itself now; the catalog it displaced lives
     one segment deeper, alongside the listing pages it always owned.

     The patterns below mirror `routes/product-destinations.ts`, which is the
     only place the router mounts any of them. Keeping the two in step matters
     more than it looks: a segment name that drifts here costs the destination
     its loading frame silently, with nothing red — which is exactly how the
     catalog's detail frame was lost, to a test asserting an `agents/official/…`
     shape the router had already stopped producing. */
  if (destination === 'agents') {
    if (segments[3] === 'marketplace') {
      return segments.length === 4 ? 'marketplace' : 'marketplace-detail'
    }
    // The agent's own document. Every other shape under `/agents` is the map,
    // and `isMapPath` above has already claimed it.
    if (segments[4] === 'settings') return 'agent-detail'
  }
  if (destination === 'settings') return 'settings'
  /* The workspace's own three, each at the top of it. They used to sit
     under a `computer` segment that grouped them as "the machine" — its disk,
     its memory, its plugs — which was a true grouping and an invisible one: the
     product never says the word anywhere a reader can see it, and the bar calls
     the first of them Drive. A prefix nobody reads is a segment nobody needs. */
  /* The short session link resolves onto an agent's page — that is where a
     session lives — so its loading frame is the page's. */
  if (destination === 'sessions') return 'agent-page'
  if (destination === 'files') return 'files'
  if (destination === 'train') return 'train'
  if (destination === 'integrations') return 'integrations'
  return 'generic'
}
