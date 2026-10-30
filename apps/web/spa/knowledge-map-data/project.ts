/* ============================================================================
   Real workspace data, projected into the knowledge map's shape.

   The map is presentational: it takes `MapData` and reports what you clicked.
   This is the seam that fills it from the product's own queries, and the one
   place that knows how a drive's vocabulary lines up with the map's.

   ---- ids carry routing ----
   The map hands whole items back through `onOpen`, so an id that is already a
   route parameter means the host can navigate without a lookup table:

     agent.id   the real agent id      -> agentJobsUrl
     file.id    the file's drive path   -> driveFolderUrl
     app.id     the app slug            -> agentsMapUrl, as the owner's card
     skill.id   the skill folder name

   Those builders own their URL grammars; nothing here writes a path.

   The one thing an id cannot carry is the agent's `slug` and `anchorPath`,
   which the drive and agent-detail routes both need. Those travel in a small
   side table rather than being smuggled into a presentational type.

   ---- no words of its own ----
   Every caption this produces is either data or comes in through `MapCopy`.
   A pure module cannot call `useTranslations`, and a map whose timestamps read
   "3 hrs ago" inside an otherwise Spanish product is worse than one that asks
   its caller for the phrase.

   ---- what is real, and what is honestly absent ----
   Real: agents, their apps, their jobs — and, when you go inside one, its
   skills (the folders under `.agents/skills`) and its files. Duet is one of
   them, projected from the same three lists: it is the drive itself, so what it
   carries is whatever no agent's anchor claimed.

   Absent, and left absent rather than invented: a job's originating sub-agent,
   whether a finished job has been read, the question an asking job is waiting
   on, a skill's description and run count. Every one of those is optional on
   `MapData`, so the map simply draws one fewer thing.
   ========================================================================= */
import {
  agentIsLaunchable,
  agentResolutionCandidate,
  groupAgentsByParent,
  ROOT_AGENT_SCOPE,
  type ActivitySessionSummary,
  type Agent,
  type App,
  type ChatActivity,
  type FileEntry,
  type IntegrationConnection,
  type MessagePreview,
} from '@repo/contract'

import { agentDisplayName, agentSubtitle } from '../agents/agent-display'
import { formatBytes } from '../format'
import type {
  AppItem,
  Agent as MapAgent,
  MapData,
  FileItem as MapFile,
  IntegrationItem as MapIntegration,
  Job as MapJob,
  Skill as MapSkill,
} from '../knowledge-map/types'
import { appDisplayStatus } from '../status/entity-status'

/** What the host needs to route somewhere the map's own ids cannot reach. */
export type AgentRoute = {
  /** the URL segment for `/agents/:agentSlug` */
  slug: string
  /** the drive anchor, relative and without a leading slash */
  anchorPath: string
  /** false for a disabled agent or one whose folder is gone; it has no chat */
  launchable: boolean
}

/**
 * When each carrier last moved, keyed by the id the map draws it under.
 *
 * The newest of its sessions — its work **and** the conversation you have with
 * it. That second half is a deliberate difference from the wire, which orders
 * owners by work alone: this feeds a *directory* of agents under the promise
 * "most recently active first", and to a person the last thing that happened
 * with an agent is the last thing that happened, whether they asked it to do
 * something or merely asked it something. The ring's seats and the response's
 * own owner order stay work-only, because those are about work.
 *
 * The agent record's own `updatedAt` is deliberately not in here: it moves on a
 * rename, and a list that claims to be ordered by activity but reshuffles
 * because somebody corrected a spelling is a list whose order the reader cannot
 * account for.
 *
 * So a carrier nobody has touched at all is **absent** rather than zero. "Has
 * not moved" and "moved at the epoch" are different facts, and the surface that
 * reads this sorts the two apart — see `agents-rail/roster.ts`.
 *
 * The jobs it measures are the bounded activity summary, including completed
 * history, so finishing work can update recency without being called live.
 */
export type MapActivity = ReadonlyMap<string, number>

/**
 * What was last said in each carrier's own conversation, keyed the same way.
 *
 * Beside `MapActivity` rather than inside it because the two answer different
 * questions with different clocks: that one is *when* work moved and is what
 * the roster sorts on; this one is *what* was said, and never reorders
 * anything. A carrier whose conversation holds nothing anyone said — nobody
 * has written to it, or everything in it is work — is absent, exactly as it is
 * from the activity table, and for the same reason: absence is a fact, and
 * inventing a placeholder for it would put an empty line under a name.
 *
 * The preview itself is the server's, cut by `messagePreviewOf` at write time.
 * Nothing here re-derives it; this only files it under the id the map draws
 * the carrier by.
 */
export type MapPreviews = ReadonlyMap<string, MessagePreview>

export type WorkspaceMap = {
  /**
   * What the ring draws: only the agents whose nearest enclosing agent is the
   * drive root. A nested agent is its parent's to show — the same one-layer
   * rule the roster prompt lives by — so it appears through `childAgentIds`
   * on its parent's surface, never as root's peer.
   */
  data: MapData
  /**
   * Every agent, ring or not, under the same node the ring would draw. Deep
   * links, the rail, and the zoomed surface resolve here: visibility is the
   * ring's business, reachability is this map's.
   */
  agentDirectory: ReadonlyMap<string, MapAgent>
  /** agentId → its direct child agents, no agent in between. */
  childAgentIds: ReadonlyMap<string, readonly string[]>
  /** agentId → its nearest enclosing agent; absent means it answers to root. */
  parentAgentIds: ReadonlyMap<string, string>
  /** keyed by the same id the map uses for an agent */
  routes: ReadonlyMap<string, AgentRoute>
  /** keyed the same way, and `ROOT_AGENT_SCOPE` for the centre */
  activity: MapActivity
  /** keyed the same way again; see `MapPreviews` for why it is not in `activity` */
  previews: MapPreviews
}

/** One agent's worth of everything the ring draws for it. */
export type AgentSlice = {
  agent: Agent
  apps: readonly App[]
  jobs: readonly ActivitySessionSummary[]
  /**
   * This owner's own conversation, as the wire named it.
   *
   * The **only** source for this record — never the copy of the same row that
   * `jobs` may also be carrying. The wire owns the split, and two producers of
   * one record is drift with extra steps. Absent means no chat yet,
   * or the read has not answered.
   *
   * `ChatActivity` rather than `SessionSummary` because the chat is the one
   * session that carries what was last said in it. Work is described by its
   * title.
   */
  chat?: ChatActivity
}

/**
 * The centre: what Duet is, and what it answers for.
 *
 * Duet is the drive root — a presentation identity, not an agent row — so it
 * is never on the ring and never comes back from `listAgents`. What it owns is
 * everything on the drive that no agent claimed: the jobs with no owning agent
 * and the apps outside every agent's anchor. Those apps are drawn hanging off
 * the centre, which is why they are a slice like any agent's rather than a
 * leftover the projection quietly drops.
 */
export type CoreFacts = {
  /** the drive's own name — the map's centre is the drive, not an abstraction */
  name: string
  /** what the centre says the drive holds, already counted and pluralised */
  meta: string
  apps: readonly App[]
  jobs: readonly ActivitySessionSummary[]
  /**
   * This owner's own conversation, as the wire named it.
   *
   * The **only** source for this record — never the copy of the same row that
   * `jobs` may also be carrying. The wire owns the split, and two producers of
   * one record is drift with extra steps. Absent means no chat yet,
   * or the read has not answered.
   *
   * `ChatActivity` rather than `SessionSummary` because the chat is the one
   * session that carries what was last said in it. Work is described by its
   * title.
   */
  chat?: ChatActivity
}

/**
 * Everything on this map that is words rather than data.
 *
 * The projection is pure and the map is presentational, so neither can call
 * `useTranslations`. The route can, and passes the result down — which also
 * means a fixture can freeze the locale and the clock and get a byte-stable
 * screenshot.
 */
export type MapCopy = {
  /** `(at, now) => 'hace 3 h'`; the product passes a locale-aware formatter */
  when: (at: number, now: number) => string
}

/**
 * The one thing on the map that is neither words nor a field on a record.
 *
 * An app's artwork is a file *on the drive*, so its URL is only knowable to
 * something holding an API client and a workspace slug — which a pure module
 * is not. The caller passes the rule in, the same way it passes the phrase for
 * "3 hrs ago", and `useDriveFileIconUrl` is where that rule actually lives so
 * the map and every other surface serve one app's icon from one place.
 */
export type MapIcons = {
  /** the URL this app's own artwork is served at, or nothing when it ships none */
  app: (app: App) => string | undefined
  /** the URL this agent's own custom icon is served at, or nothing when it wears the generated one */
  agent: (agent: Agent) => string | undefined
}

/* The map used to collapse a session's five turn statuses onto three states of
   its own, and separately derive "on a clock" from the machine's activity. Both
   readings are now one column — `bucket` — decided once by `bucketOf` in the
   contract and stamped on the row. A projection that re-derived it here would be
   a second definition of the product's central concept, free to drift from the
   one the index is keyed on. */

function jobStep(job: ActivitySessionSummary): string | undefined {
  return job.machine?.step
}

function jobProgress(job: ActivitySessionSummary): number | undefined {
  const progress = job.machine?.progress
  if (progress === undefined || progress.total <= 0) return undefined
  return progress.completed / progress.total
}

export function toMapJob(job: ActivitySessionSummary, now: number, copy: MapCopy): MapJob {
  const wakeAt = job.machine?.nextWakeAt
  return {
    id: job.id,
    title: job.title,
    when: copy.when(job.updatedAt, now),
    /* The raw stamp beside the phrased one: `when` is for a reader and this is
       for a comparison, and deriving the second from the first is not possible
       once it says "4 min ago". */
    updatedAt: job.updatedAt,
    state: job.bucket,
    unread: job.unread,
    step: jobStep(job),
    progress: jobProgress(job),
    /* Only a scheduled job has a wake time worth printing; on any other state
       a stale `nextWakeAt` would read as a promise the job is not making. */
    wakesIn:
      job.bucket === 'scheduled' && wakeAt !== undefined ? copy.when(wakeAt, now) : undefined,
  }
}

export function toMapSkill(name: string): MapSkill {
  /* Skills are folder names on the drive. There is no description behind them —
     reading a SKILL.md per entry would cost one request each for a sentence the
     map has no room to print. */
  return { id: name, title: name, blurb: '' }
}

/* `.agents` and the agent's own manifest are how an agent is configured, not
   what it keeps. Showing them would make every agent's Files branch open on the
   same three pieces of plumbing. */
const HIDDEN_FILES = new Set(['AGENTS.md', 'agent.json'])

/* The map prints the extension itself on the card and buckets it into one of
   four families for colour, so the extension is what it wants — not the glyph
   key the drive uses to pick an icon. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'file'
  return name.slice(dot + 1).toLowerCase()
}

export function toMapFile(entry: FileEntry, now: number, copy: MapCopy): MapFile {
  const mtime = Date.parse(entry.mtime)
  const folder = entry.type === 'directory'
  return {
    id: entry.path,
    title: entry.name,
    kind: folder ? 'folder' : fileExtension(entry.name),
    folder: folder ? true : undefined,
    /* A directory's `size` is its inode's, not its contents' — printing it
       would be a number that means nothing to the person reading it. */
    size: folder ? undefined : formatBytes(entry.size, 1000),
    /* An unparseable mtime prints nothing rather than "NaN minutes ago". */
    when: Number.isFinite(mtime) ? copy.when(mtime, now) : '',
  }
}

/* Folders count. An agent that keeps its work in `reports/` and `data/` has a
   full drive, and a branch that says "Files · 0" because it only counted loose
   files at the top level is asserting emptiness it never checked. Symlinks are
   left out: the thing they point at is already listed, or is outside the
   agent's folder and not the agent's to claim. */
export function visibleFiles(entries: readonly FileEntry[]): readonly FileEntry[] {
  return entries.filter(
    entry =>
      entry.type !== 'symlink' && !entry.name.startsWith('.') && !HIDDEN_FILES.has(entry.name),
  )
}

/* An app on the drive is always installed; what varies is whether it is up.
   `appDisplayStatus` is the product's own answer to that — and it is the answer
   worth deferring to, because "up" is not just `runtimeStatus`: a disabled app
   or one whose anchor is broken is down however cleanly it last reconciled.

   An app tile has two states by design — the map says whether you can use the
   thing, and leaves *why not* to the app's own page, which has room for it. So
   the five collapse to two, and only a live app is "connected". */
export function appState(app: App): AppItem['state'] {
  return appDisplayStatus(app) === 'reconciled' ? 'connected' : 'available'
}

export function toMapApp(app: App, now: number, copy: MapCopy, icons: MapIcons): AppItem {
  return {
    id: app.slug,
    title: app.name ?? app.slug,
    when: copy.when(app.updatedAt, now),
    state: appState(app),
    icon: icons.app(app),
  }
}

/* A connection has four statuses on the wire and the map has one axis, so they
   are lined up rather than recoloured. `disconnected` is not one of the three:
   it is a record of something that used to be true, the integrations
   destination already filters it out of what it draws, and a row that says
   "gone" is not something an agent can reach. */
export function toMapIntegration(connection: IntegrationConnection): MapIntegration {
  return {
    id: connection.id,
    title: connection.name ?? connection.integration,
    provider: connection.integration,
    /* Broken is `asking` — work that has stopped and wants you — which is the
       one thing on this map allowed to be coral. Being set up is `running`. A
       live connection is the resting case and wears nothing at all. */
    state:
      connection.status === 'active'
        ? 'connected'
        : connection.status === 'pending'
          ? 'running'
          : 'asking',
    logoUrl: connection.logoUrl,
  }
}

/** The ones an agent can actually reach, most in need of you first. */
export function visibleIntegrations(
  connections: readonly IntegrationConnection[],
): readonly MapIntegration[] {
  const rank = { asking: 0, running: 1, connected: 2 } as const
  return connections
    .filter(connection => connection.status !== 'disconnected')
    .map(toMapIntegration)
    .sort((a, b) => rank[a.state] - rank[b.state] || a.title.localeCompare(b.title))
}

/* The owner's own chat, on the face rather than in the work.

   The split itself is the wire's: `sessions` is what an owner did and `chat` is
   the conversation it *is*, told apart by the pointer no row carries. This only
   dresses each side for the map — so there is no filter here, and there must
   not be one. A client-side "and also drop this id" would be a second answer to
   a question the response has already answered, and the two would disagree the
   moment one of them was wrong.

   A set of at most one, because an owner has exactly one default chat: the cap
   is the pointer's, not a clamp in whatever draws it. */
function splitChat(
  jobs: readonly ActivitySessionSummary[],
  chat: ChatActivity | undefined,
  now: number,
  copy: MapCopy,
): { jobs: readonly MapJob[]; chat?: readonly MapJob[] } {
  const work = jobs.map(job => toMapJob(job, now, copy))
  return chat === undefined ? { jobs: work } : { jobs: work, chat: [toMapJob(chat, now, copy)] }
}

export function toMapAgent(
  slice: AgentSlice,
  now: number,
  copy: MapCopy,
  icons: MapIcons,
): MapAgent {
  return {
    id: slice.agent.id,
    name: agentDisplayName(slice.agent),
    avatarKey: slice.agent.slug,
    subtitle: agentSubtitle(slice.agent),
    /* The wire's own reading of whether this agent can be talked to. The zoom
       mounts a conversation, and the sessions surface refuses a non-launchable
       agent — so the host needs to know before it does. */
    locked: !agentIsLaunchable(slice.agent),
    icon: icons.agent(slice.agent),
    ...splitChat(slice.jobs, slice.chat, now, copy),
    apps: slice.apps.map(app => toMapApp(app, now, copy, icons)),
  }
}

/**
 * Duet, in the same shape an agent comes out in, so one surface draws both.
 *
 * Duet has no row, so it has no id of its own — it answers to
 * `ROOT_AGENT_SCOPE`, the token session filters, job filters, and the
 * `/agents/root` route already use. This projection once minted a private
 * `'core'` for the job, because nothing stopped a real agent from colliding
 * with whatever it picked; reserving `root` as a slug is what made the shared
 * token safe, and one name for the default agent beats a second vocabulary only
 * this module speaks. (`KnowledgeMapZoom.kind === 'core'` is unrelated — that
 * discriminates UI state, not which entity is being named.)
 */
export function toDuet(core: CoreFacts, now: number, copy: MapCopy, icons: MapIcons): MapAgent {
  return {
    id: ROOT_AGENT_SCOPE,
    name: core.name,
    /* Duet wears authored art rather than a generated face, so this is only
       what it falls back to if that art will not draw — and `root` is the same
       token its scope, its route and its slug already use. */
    avatarKey: ROOT_AGENT_SCOPE,
    locked: true,
    ...splitChat(core.jobs, core.chat, now, copy),
    apps: core.apps.map(app => toMapApp(app, now, copy, icons)),
  }
}

/* A loop rather than `Math.max(...jobs)`: the spread is one argument per job on
   a list that pages, and the day a drive is busy enough to matter is the day it
   overflows the call stack rather than the day it gets slow. */
function lastMoved(jobs: readonly ActivitySessionSummary[]): number | undefined {
  let newest: number | undefined
  for (const job of jobs) {
    if (newest === undefined || job.updatedAt > newest) newest = job.updatedAt
  }
  return newest
}

/** An owner's sessions as the directory counts them: its work, and its chat. */
function withChat(
  jobs: readonly ActivitySessionSummary[],
  chat: ChatActivity | undefined,
): readonly ActivitySessionSummary[] {
  return chat === undefined ? jobs : [...jobs, chat]
}

export function projectWorkspaceMap(
  core: CoreFacts,
  slices: readonly AgentSlice[],
  now: number,
  copy: MapCopy,
  icons: MapIcons,
): WorkspaceMap {
  const routes = new Map<string, AgentRoute>()
  const activity = new Map<string, number>()
  const previews = new Map<string, MessagePreview>()
  const coreMoved = lastMoved(withChat(core.jobs, core.chat))
  if (coreMoved !== undefined) activity.set(ROOT_AGENT_SCOPE, coreMoved)
  if (core.chat?.preview !== undefined) previews.set(ROOT_AGENT_SCOPE, core.chat.preview)
  for (const slice of slices) {
    routes.set(slice.agent.id, {
      slug: slice.agent.slug,
      anchorPath: slice.agent.anchorPath,
      launchable: agentIsLaunchable(slice.agent),
    })
    const moved = lastMoved(withChat(slice.jobs, slice.chat))
    if (moved !== undefined) activity.set(slice.agent.id, moved)
    if (slice.chat?.preview !== undefined) previews.set(slice.agent.id, slice.chat.preview)
  }
  /* The one containment rule the whole feature shares — never a path-prefix
     test here. `groupAgentsByParent` is self-excluding and treats "one layer"
     as measured in agents, so a folder between two agents adds no layer and a
     slug that happens to prefix another never nests. */
  const hierarchy = groupAgentsByParent(slices.map(slice => agentResolutionCandidate(slice.agent)))
  const ringIds = new Set(hierarchy.rootChildren.map(candidate => candidate.agentId))
  const agentDirectory = new Map<string, MapAgent>(
    slices.map(slice => [slice.agent.id, toMapAgent(slice, now, copy, icons)]),
  )
  const childAgentIds = new Map<string, readonly string[]>(
    [...hierarchy.childrenByAgentId].map(([agentId, children]) => [
      agentId,
      children.map(child => child.agentId),
    ]),
  )
  const parentAgentIds = new Map<string, string>(
    [...hierarchy.parentByAgentId].map(([agentId, parent]) => [agentId, parent.agentId]),
  )
  return {
    data: {
      duet: toDuet(core, now, copy, icons),
      coreMeta: core.meta,
      agents: slices
        .filter(slice => ringIds.has(slice.agent.id))
        .map(slice => agentDirectory.get(slice.agent.id)!),
    },
    agentDirectory,
    childAgentIds,
    parentAgentIds,
    routes,
    activity,
    previews,
  }
}
