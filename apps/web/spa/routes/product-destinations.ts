// Pure data: no React or icon imports — the public route manifest
// (app/product-route-manifest.json) consumes this at build time in a
// server context where client-only modules cannot load. Icons and lazy
// route components live in ./product-destination-views.tsx, keyed by
// ProductDestinationId so a new destination cannot ship without both.
export type ProductDestination = {
  id:
    | 'workHome'
    | 'agentsGraph'
    | 'agentPage'
    | 'sessions'
    | 'agentDetail'
    | 'agentTrain'
    | 'marketplace'
    | 'files'
    | 'desktop'
    | 'train'
    | 'integrations'
    | 'workspaceSettings'
    | 'userSettings'
    | 'internalAdmin'
  pathPatterns: readonly string[]
}

/* ---- the order of this table decides nothing ----
   Both readers ignore it. React Router ranks by specificity, so `agents/*` and
   `agents/:agentSlug/settings` resolve correctly whichever way round they are
   declared; the deployed route manifest only maps. Read it in whatever order
   reads best.

   Worth saying out loud, because a first-to-last matcher over this table used to
   exist, and the note here used to warn that a destination declared after the
   map's splat would be read as an agent named "marketplace". A table whose order
   quietly stopped mattering is one somebody re-sorts in fear. */
export const PRODUCT_DESTINATIONS = [
  {
    id: 'workHome',
    pathPatterns: ['home'],
  },
  {
    /* The catalog, under `/agents/marketplace` — where its own listing pages
       already lived — because the map answers for `/agents` itself. */
    id: 'marketplace',
    pathPatterns: ['agents/marketplace', 'agents/marketplace/:publisherSlug/:agentName'],
  },
  {
    /* The agent's own document: what it is, what it knows, what it has done,
       and the menu that renames or deletes it. It used to own `agents/:agentSlug`
       outright, which meant the one path an agent naturally writes when it names
       a colleague — see the `manage-agents` skill — landed on a configuration
       page rather than on the agent. It sits beside the agent now, one segment
       further in, and the bare path means the agent. */
    id: 'agentDetail',
    pathPatterns: ['agents/:agentSlug/settings'],
  },
  {
    id: 'agentTrain',
    pathPatterns: ['agents/:agentSlug/train', 'agents/:agentSlug/train/:memorySlug'],
  },
  {
    /* The drive's portrait of itself. Work Home owns the workspace front door;
       Build keeps the graph at this explicit destination. */
    id: 'agentsGraph',
    pathPatterns: ['agents/graph'],
  },
  {
    /* One agent, unfolded — and a destination of its own rather than a tail the
       map reads off its own URL.

       These used to be one splat (`agents/*`), deliberately: React Router
       reconciles by position, so sibling entries pointing at one element tear
       the canvas down and rebuild it when the reader moves between them, and
       that would have restarted the camera and killed the flight into the face.
       There is no flight and no canvas to keep alive. Tearing it down is the
       point — an agent is a page, and the map is not on it.

       One pattern, and the bare path is inside it. React Router reconciles by
       position, so two sibling patterns for one element remount the destination
       whenever a path crosses between them — which the entry rewrite does on
       every cold landing, and which is not survivable now that a persistent
       roster lives in the same subtree. A single splat matches `agents`,
       `agents/ops` and every card tail alike, so the tail under an agent (its
       apps, its folder, the desktop, its sessions) selects what the *card*
       shows without ever leaving this destination. `agents-map-url` still owns
       that grammar; this table only says where the reader is. The static
       siblings above — `agents/graph`, `agents/marketplace`,
       `agents/:agentSlug/settings`, `…/train` — outrank it on specificity and
       are unaffected. */
    id: 'agentPage',
    pathPatterns: ['agents/*'],
  },
  {
    /* Not a surface — a redirect. A session's one address is on its agent
       (`agents/:agentSlug/sessions/:sessionId`), and nothing in the product
       links here. The shape survives for one writer: an agent in the sandbox
       holds a session id and the workspace slug, and asking it to also resolve
       the owning agent before it may emit a link is complexity in the wrong
       place — so an agent working from the session API emits this, and one read here turns
       it into the real address. The bare path just goes to the map. */
    id: 'sessions',
    pathPatterns: ['sessions', 'sessions/:sessionId'],
  },
  {
    id: 'files',
    pathPatterns: ['files/*'],
  },
  {
    id: 'desktop',
    pathPatterns: ['desktop'],
  },
  {
    /* One control centre with the roster down its left side; the path says
       which row is selected and, one segment deeper, which memory is open.
       Bare `train` is kept only to send a reader to `…/train/root` —
       the drive's own scope is a named row like every other one now. */
    id: 'train',
    pathPatterns: ['train', 'train/:agentSlug', 'train/:agentSlug/:memorySlug'],
  },
  {
    id: 'integrations',
    pathPatterns: ['integrations'],
  },
  {
    id: 'workspaceSettings',
    pathPatterns: [],
  },
  {
    id: 'userSettings',
    pathPatterns: [],
  },
  {
    id: 'internalAdmin',
    pathPatterns: [],
  },
] as const satisfies readonly ProductDestination[]

export type ProductDestinationId = (typeof PRODUCT_DESTINATIONS)[number]['id']
