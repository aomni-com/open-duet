import { z } from 'zod'

import { AnchorStateSchema } from '../anchors/index'
import { AppDeclarationSchema } from '../apps/index'
import { normalizeDrivePath } from '../drive/index'
import {
  COLLECTION_PAGE_MAX_LIMIT,
  CollectionPageQuerySchema,
  collectionPageSchema,
} from '../pagination/index'
import { IconPathSchema, SafeRelativePathSchema } from '../relative-path/index'
import { AppSlugSchema, ROOT_AGENT_SCOPE } from '../slug/index'

/**
 * What an agent is called on screen — the one rule, whichever agent wears it.
 *
 * 32 rather than something roomier because the SHORTEST surface decides: the
 * default agent's name is the knowledge map's centre label and the mobile
 * header, and a name that overflows there is worse than one the author had to
 * shorten. A registered agent's name renders in those same places.
 */
export const MAX_AGENT_NAME_LENGTH = 32
/**
 * What the drive root is called before anyone renames it. It lives here rather
 * than in the web app because it is now wire-visible model identity: a session
 * message from root renders `agent_name` from the workspace's `duetName`, and
 * falls back to this when the workspace never set one.
 */
export const DEFAULT_AGENT_NAME = 'Duet'
/**
 * The characters a name may not contain, and the whole of that rule.
 *
 * A name is written into two grammars it does not control: the mention tag an
 * @ mention emits, and the Markdown link its chip becomes. Square brackets,
 * angle brackets and the backtick break one or both, and a control character
 * breaks a tag that has to stay on one line. Everything else — quotes,
 * ampersands, slashes, parens, accents, emoji, internal spaces — stays legal,
 * because this is markup safety, not a naming policy, and a tidier rule would
 * only take names away from people.
 *
 * Deliberately `\p{Cc}` and not `\p{C}`: format characters are fine, and the
 * zero-width joiner is what holds a multi-person emoji together. Emptiness is
 * `min(1)`'s business, not this pattern's.
 */
const AGENT_NAME_PATTERN = /^[^[\]<>`\p{Cc}]*$/u
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AGENT_NAME_LENGTH)
  .regex(AGENT_NAME_PATTERN, 'A name cannot contain [ ] < > ` or control characters')
export const AgentIconSchema = IconPathSchema
export const MAX_AGENTS_PER_WORKSPACE = 50

// `agent.json` is synced drive content, so the parser on the other side is
// whatever version that workspace's VM or browser happens to be running. The
// config grammar is therefore `.loose()`: declared fields validate hard (a
// missing required field or a wrong type still fails) while unknown fields
// pass through untouched, because authored content has to survive a
// round-trip by a reader that predates the field. Rejecting an unknown key
// would make adding one field a fleet-wide, deploy-ordered migration.
export const AgentOnboardingSchema = z.discriminatedUnion('kind', [
  // Authored agent.json content must preserve fields added by newer writers.
  z.object({ kind: z.literal('chat') }).loose(),
  z
    .object({
      kind: z.literal('app'),
      // A path relative to the agent root, never an app slug: a shared replica's
      // slug may be collision-suffixed while its path under the mount is
      // preserved, so only the path resolves the same app in every workspace.
      app: SafeRelativePathSchema,
      hideAfterOnboarded: z.boolean().optional(),
    })
    // Authored agent.json content must preserve fields added by newer writers.
    .loose(),
])
export type AgentOnboarding = z.infer<typeof AgentOnboardingSchema>

/**
 * What an agent is FOR, as a browsing vocabulary. Ordered: this is the order
 * filter chips render in and the order `resolveAgentTags` emits, so two agents
 * carrying the same tags always look the same.
 */
export const AGENT_TAGS = [
  'sales',
  'marketing',
  'engineering',
  'customer-support',
  'operations',
  'people',
  'product',
  'personal',
] as const
export type AgentTag = (typeof AGENT_TAGS)[number]
export const AgentTagSchema = z.enum(AGENT_TAGS)

/** At most this many per agent, so a card's chip row stays readable. */
export const MAX_AGENT_TAGS = 3

const AGENT_TAG_SET: ReadonlySet<string> = new Set(AGENT_TAGS)

/**
 * Authored strings to vocabulary. The ONLY place a string becomes a tag.
 *
 * Unknown values drop rather than reject, because the vocabulary is compiled
 * into whichever build a reader happens to be running: an agent authored
 * against a newer tag list must not become unreadable on an older VM.
 */
export function resolveAgentTags(raw: unknown): AgentTag[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<AgentTag>()
  for (const value of raw) {
    if (typeof value === 'string' && AGENT_TAG_SET.has(value)) seen.add(value as AgentTag)
  }
  return AGENT_TAGS.filter(tag => seen.has(tag)).slice(0, MAX_AGENT_TAGS)
}

export const AgentConfigSchema = z
  .object({
    // Reserved and still empty, but optional: a config that sets only
    // `trainable` or `onboarding` is well-formed.
    triggers: z.array(z.never()).optional(),
    trainable: z.boolean().optional(),
    onboarding: AgentOnboardingSchema.optional(),
    /* DELIBERATELY `string`, not `AgentTagSchema`. This object is `.loose()`,
       which means declared fields validate HARD — so an enum here would make
       one unrecognised tag throw, and the catch in `resolveAgentConfig` turns
       any throw into UNREADABLE_CONFIG, silently discarding the agent's
       onboarding block and trainable flag. A tag typo would break onboarding.
       The vocabulary is applied by `resolveAgentTags` instead, where an
       unknown value costs only itself. */
    tags: z.array(z.string()).optional(),
    /* DELIBERATELY `unknown`, for the same reason as `tags`: a wrong-typed
       value here must cost only the suggestion, not the whole config.
       Normalized by `normalizeAgentFirstMessage`. */
    suggestedFirstMessage: z.unknown().optional(),
  })
  // Authored agent.json content must preserve fields added by newer writers.
  .loose()
export type AgentConfig = z.infer<typeof AgentConfigSchema>

// The normalized onboarding shape every reader sees, with `hideAfterOnboarded`
// already defaulted so no consumer re-decides what an omitted flag means.
export type AgentOnboardingConfig =
  | { kind: 'chat' }
  | { kind: 'app'; app: string; hideAfterOnboarded: boolean }

export interface AgentEffectiveConfig {
  // `false` when the file was missing, unparseable, or schema-invalid. Every
  // derived surface treats that as the permissive state — an agent is never
  // locked, and never loses its train surface, because its config could not be
  // read. See `resolveAgentConfig`.
  readable: boolean
  trainable: boolean
  tags: AgentTag[]
  onboarding?: AgentOnboardingConfig
  /* An agent's suggested first message: what an empty default chat renders as
     the agent's opening, and what the client materializes into history with
     the user's first send. A suggestion the client may ignore — never a
     required part of the API. */
  suggestedFirstMessage?: string
}

const UNREADABLE_CONFIG: AgentEffectiveConfig = { readable: false, trainable: true, tags: [] }

/**
 * The single owner of `agent.json` semantics: JSON parsing, defaults, and the
 * fail-open result. The gateway and the web app both resolve through this so a
 * config can never mean two different things on the two sides of the wire.
 *
 * `undefined` source is the missing-file case. Any parse or schema failure
 * degrades to the same permissive config rather than raising — malformed
 * config must never block a session or strand a user behind a lock.
 */
export function resolveAgentConfig(source: string | undefined): AgentEffectiveConfig {
  if (source === undefined) return UNREADABLE_CONFIG
  let config: AgentConfig
  try {
    config = AgentConfigSchema.parse(JSON.parse(source))
  } catch {
    return UNREADABLE_CONFIG
  }
  const suggestedFirstMessage = normalizeAgentFirstMessage(config.suggestedFirstMessage)
  return {
    readable: true,
    trainable: config.trainable ?? true,
    tags: resolveAgentTags(config.tags),
    ...(config.onboarding === undefined
      ? {}
      : { onboarding: normalizeOnboarding(config.onboarding) }),
    ...(suggestedFirstMessage === undefined ? {} : { suggestedFirstMessage }),
  }
}

/**
 * The ceiling on an agent's first message, enforced at every seam that
 * carries one: the config read below, the default-session request schema,
 * and the create path's backstop. One constant, so the bubble a user saw,
 * the text the client sent, and the event history stored can never diverge
 * over length.
 */
export const AGENT_FIRST_MESSAGE_MAX_LENGTH = 2_000

/**
 * The one normalizer of agent-first-message text, shared by the config read
 * and the Convex create path. Tolerant like `resolveAgentTags`: a
 * wrong-typed or blank value means "no message", never a throw. Clamping
 * here (not just on the wire) matters: an over-long authored suggestion must
 * shorten the bubble, not 400 the user's first send.
 */
export function normalizeAgentFirstMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().slice(0, AGENT_FIRST_MESSAGE_MAX_LENGTH).trimEnd()
  return trimmed === '' ? undefined : trimmed
}

function normalizeOnboarding(onboarding: AgentOnboarding): AgentOnboardingConfig {
  return onboarding.kind === 'chat'
    ? { kind: 'chat' }
    : {
        kind: 'app',
        app: onboarding.app,
        hideAfterOnboarded: onboarding.hideAfterOnboarded ?? true,
      }
}

/**
 * Whether an agent is still waiting on the user before it can do its job.
 *
 * All three conditions matter, and the middle one is the whole point:
 * `onboardedAt === undefined` on its own is the permanent, ordinary state of
 * every agent that never declared an `onboarding` block, which is most of them.
 * Reading the timestamp alone marks nearly every working agent as unfinished.
 *
 * Lives here rather than in the web app because the gateway needs the same
 * verdict when it renders an agent roster into a system prompt, and a second
 * copy of a three-part predicate is a second answer waiting to happen.
 */
export function agentIsLocked(
  agent: Pick<Agent, 'onboardedAt'>,
  config: AgentEffectiveConfig,
): boolean {
  return config.readable && config.onboarding !== undefined && agent.onboardedAt === undefined
}

export const AgentIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>

// Accept-and-ignore, not pass-through: a row carrying a field this reader does
// not know must not throw (a return-shape change has broken a strict parse here
// before), but the explicit `toAgent` projection — not this schema — is what
// keeps internal columns out of the response, and a pass-through index
// signature would erase the response typing downstream.
export const AgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  anchorId: z.string(),
  anchorPath: z.string().min(1),
  anchorState: AnchorStateSchema,
  slug: AppSlugSchema,
  name: AgentNameSchema.optional(),
  icon: AgentIconSchema.optional(),
  sourceShareId: z.string().optional(),
  sourceAgentId: z.string().optional(),
  listingSubscriptionId: z.string().optional(),
  disabledAt: z.number().int().nonnegative().optional(),
  // Per-workspace onboarding completion. A shared replica carries its own
  // value: replication never copies, clears, or propagates it.
  onboardedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type Agent = z.infer<typeof AgentSchema>

export const RegisterAgentRequestSchema = z.object({
  path: z.string().trim().min(1),
  slug: AppSlugSchema,
  name: AgentNameSchema.optional(),
  icon: AgentIconSchema.optional(),
  // The apps that are part of the agent, registered atomically with the agent:
  // one register call materialises the whole agent, wherever the call comes
  // from. Optional because most agents genuinely have no app — not for
  // compatibility with older callers. Every entry's path must sit under the
  // agent's own path; the registration owner refuses anything outside it.
  apps: z.array(AppDeclarationSchema).optional(),
})
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>

export const UpdateAgentRequestSchema = z
  .object({
    name: AgentNameSchema.optional(),
    icon: AgentIconSchema.optional(),
  })
  .refine(value => value.name !== undefined || value.icon !== undefined)
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>

/**
 * Renaming the default agent.
 *
 * Its name is `workspaces.duetName` — the drive root has no `agents` row to
 * carry one — so this deliberately does NOT answer with an `Agent`. An
 * agent-shaped URL that had to mint an agent-shaped response would be inventing
 * a row the product does not have; the small echo keeps the URL honest.
 *
 */
export const UpdateDefaultAgentRequestSchema = z.object({ name: AgentNameSchema })
export type UpdateDefaultAgentRequest = z.infer<typeof UpdateDefaultAgentRequestSchema>

export const DefaultAgentResponseSchema = z.object({ name: AgentNameSchema })
export type DefaultAgentResponse = z.infer<typeof DefaultAgentResponseSchema>

export const SetAgentDisabledRequestSchema = z.object({ disabled: z.boolean() })
export type SetAgentDisabledRequest = z.infer<typeof SetAgentDisabledRequestSchema>

// Setting and clearing share one idempotent toggle so "redo onboarding" needs
// no second endpoint.
export const SetAgentOnboardedRequestSchema = z.object({ onboarded: z.boolean() })
export type SetAgentOnboardedRequest = z.infer<typeof SetAgentOnboardedRequestSchema>

// Opening an onboarding conversation returns only its id: the session itself is
// fetched through the ordinary session detail route, because it IS an ordinary
// session in every respect except that no list will show it.
export const OpenOnboardingSessionResponseSchema = z.object({ sessionId: z.string().min(1) })
export type OpenOnboardingSessionResponse = z.infer<typeof OpenOnboardingSessionResponseSchema>

export const AgentResponseSchema = z.object({ agent: AgentSchema })
export type AgentResponse = z.infer<typeof AgentResponseSchema>

/**
 * One declared app as the register call actually left it: the row's real slug
 * (an existing path keeps its born slug, a taken slug gets suffixed — neither
 * is necessarily what the caller asked for), its normalized path, and what
 * this call did — `created` a new row, `updated` an existing one whose
 * declaration differed, or found it `unchanged` and wrote nothing.
 */
export const RegisteredAgentAppSchema = z.object({
  slug: AppSlugSchema,
  path: z.string().min(1),
  status: z.enum(['created', 'updated', 'unchanged']),
})
export type RegisteredAgentAppResult = z.infer<typeof RegisteredAgentAppSchema>

/**
 * Registration answers with what it registered — the agent AND every app the
 * call declared. `apps` exists because a response that says nothing about
 * them cannot be distinguished from a server that silently dropped them: a
 * staging API that predated the `apps` request field answered 201 while
 * discarding the array (zod strips unknown keys), and only the audit log
 * could tell. Callers verify the response, not their own request.
 */
export const RegisterAgentResponseSchema = z.object({
  agent: AgentSchema,
  apps: z.array(RegisteredAgentAppSchema),
})
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponseSchema>

export const AgentListQuerySchema = CollectionPageQuerySchema.extend({
  id: z.string().min(1).optional(),
  slug: AppSlugSchema.optional(),
}).superRefine((query, ctx) => {
  if (query.id !== undefined && query.slug !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'id and slug filters are mutually exclusive' })
  }
})
export type AgentListQuery = z.input<typeof AgentListQuerySchema>
export const AgentListResponseSchema = collectionPageSchema(AgentSchema)
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>

export const DeleteAgentResponseSchema = z.object({ ok: z.literal(true) })
export type DeleteAgentResponse = z.infer<typeof DeleteAgentResponseSchema>

export interface AgentResolutionCandidate {
  agentId: string
  anchorId: string
  rootPath: string
  displayName?: string
}

export function resolveNearestAgent<T extends AgentResolutionCandidate>(
  cwd: string,
  candidates: readonly T[],
): T | null {
  const normalizedCwd = normalizeDrivePath(cwd, { allowRoot: true })
  if (!normalizedCwd.ok || normalizedCwd.relativePath === '') return null

  let nearest: { candidate: T; depth: number } | null = null
  for (const candidate of candidates) {
    const normalizedRoot = normalizeDrivePath(candidate.rootPath)
    if (!normalizedRoot.ok) continue
    const rootPath = normalizedRoot.relativePath
    if (
      normalizedCwd.relativePath !== rootPath &&
      !normalizedCwd.relativePath.startsWith(`${rootPath}/`)
    ) {
      continue
    }
    const depth = rootPath.split('/').length
    if (nearest === null || depth > nearest.depth) nearest = { candidate, depth }
  }
  return nearest?.candidate ?? null
}

/**
 * One roster row on the VM-sync wire — how the gateway learns which agents a
 * session may address, since `GatewayAnchor` deliberately carries only path
 * identity (D9: anchors own paths, agents own identity; they join on agentId).
 *
 * A discriminated union because the drive root is genuinely not an agent row:
 * it has no anchor and no database id, but it IS addressable (`agents/root`),
 * and a direct child of root cannot name its parent unless the wire carries
 * root explicitly. The reserved-slug grammar keeps the union honest — no
 * registered agent may claim `root`, so `kind` and `slug` can never contradict.
 *
 * Strip-by-default like `GatewayAppConfigSchema`: tolerate (drop) fields from a
 * newer producer, never reject them, never echo them onward.
 */
export const GatewayAgentConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('root'),
    slug: z.literal(ROOT_AGENT_SCOPE),
    name: AgentNameSchema,
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().min(1),
    anchorId: z.string().min(1),
    anchorPath: z.string().min(1),
    slug: AppSlugSchema,
    name: AgentNameSchema,
    /** Absent means never onboarded. Only meaningful beside a readable agent.json. */
    onboardedAt: z.number().int().nonnegative().optional(),
  }),
])
export type GatewayAgentConfig = z.infer<typeof GatewayAgentConfigSchema>
export type GatewayAgentRow = Extract<GatewayAgentConfig, { kind: 'agent' }>

/**
 * The whole roster as it rides the VM-sync wire, `+1` for the synthetic root
 * member on top of the per-workspace agent limit.
 *
 * Per-row tolerance, the same rule the workspace skill listing uses for an
 * unreadable skill: a row this reader cannot parse is dropped, never fatal.
 * The gateway parses the sync response as one unit, so a rejecting row would
 * cost far more than itself — anchors, updates and credentials all ride the
 * same payload, and every colleague would vanish from every system prompt
 * because one name predates a rule. One bad row never costs the other rows.
 */
export const GatewayAgentRosterSchema = z
  .array(z.unknown())
  .max(MAX_AGENTS_PER_WORKSPACE + 1)
  .transform(rows =>
    rows.flatMap(row => {
      const agent = GatewayAgentConfigSchema.safeParse(row)
      return agent.success ? [agent.data] : []
    }),
  )

/**
 * How a listed agent stands to the session reading the list, and the whole of
 * what a reader may infer about reaching it.
 *
 * It is a value rather than a position because both surfaces that show a roster
 * — the agent's own `your-agents.md` and the compose bar's `@` picker — have to
 * say the same word about the same agent, and a relationship each of them
 * derives from which array a row arrived in is a relationship each of them can
 * derive differently.
 *
 * The policy the words carry lives in the prompt, not here: work goes DOWN to
 * children, UP only as a report or a question, and SIDEWAYS to a sibling only
 * when no child can take it. Nothing enforces that — it is guidance an agent
 * reads, and the ordering of this union is the order rows are projected in.
 */
export const AGENT_RELATIONSHIPS = ['self', 'parent', 'sibling', 'child'] as const
export const AgentRelationshipSchema = z.enum(AGENT_RELATIONSHIPS)
export type AgentRelationship = (typeof AGENT_RELATIONSHIPS)[number]

/**
 * One agent a session may address — the wire form of the gateway's reachable
 * roster, read by the compose bar's `@` picker.
 *
 * `name` is resolved by the server (`name ?? slug`), so no client re-derives a
 * display name, and `locked` is the server's verdict on declared-but-unfinished
 * onboarding; both are read, never recomputed. `path` is the agent's anchor
 * folder, which is what the browser needs to open its page.
 */
export const AgentRosterRowSchema = z
  .object({
    slug: z.string().min(1),
    name: AgentNameSchema,
    /* Optional because the drive root is addressable and has no folder of its
       own; every other row carries one. */
    path: z.string().min(1).optional(),
    locked: z.boolean(),
    relationship: AgentRelationshipSchema,
  })
  /* The drive root is the only folderless agent, and it is only ever the agent
     you are (root scope) or the agent above you — never a peer, never below.
     So a pathless sibling or child is a roster contradicting itself, and the
     asymmetry survives the collapse to one row shape rather than becoming a
     rule the producer is merely trusted to keep. */
  .refine(
    row => row.path !== undefined || row.relationship === 'self' || row.relationship === 'parent',
    {
      error: 'Only the drive root may omit a folder, and it is never a sibling or a child',
      path: ['path'],
    },
  )

/**
 * A session's reachable colleagues, in the order the gateway projected them:
 * itself, the agent above it, its peers, then the agents beneath it. The client
 * re-sorts nothing, hides nothing, and derives no relationship of its own.
 *
 * One array rather than a field per relationship, because the relationship is a
 * verdict — the same verdict the prompt and the picker must agree on — and a
 * verdict carried by position is one each consumer re-derives. An empty list is
 * a real answer ("no agents yet"); a gateway that cannot answer says so with a
 * status, never with this shape.
 */
export const GatewayAgentRosterResponseSchema = z.object({
  rows: z.array(AgentRosterRowSchema).max(MAX_AGENTS_PER_WORKSPACE + 1),
})
export type GatewayAgentRosterResponse = z.infer<typeof GatewayAgentRosterResponseSchema>

/** The public API pages the bounded gateway projection without re-deriving it. */
export const AgentRosterPageQuerySchema = CollectionPageQuerySchema
export type AgentRosterPageQuery = z.infer<typeof AgentRosterPageQuerySchema>
export const AgentRosterPageSchema = collectionPageSchema(AgentRosterRowSchema).extend({
  items: z.array(AgentRosterRowSchema).max(COLLECTION_PAGE_MAX_LIMIT),
})
export type AgentRosterPage = z.infer<typeof AgentRosterPageSchema>
export type AgentRosterWireRow = z.infer<typeof AgentRosterRowSchema>

/**
 * The `anchorPath → rootPath` adapter for roster rows, mirroring
 * {@link agentResolutionCandidate} so the rename lives in exactly one shape.
 * Root has no path and takes no part in containment, so only agent rows adapt.
 */
export function gatewayAgentCandidate(
  agent: GatewayAgentRow,
): AgentResolutionCandidate & GatewayAgentRow {
  return { ...agent, rootPath: agent.anchorPath }
}

export type AgentHierarchy<T> = {
  /** Agents no other agent encloses. They answer to the drive root. */
  rootChildren: readonly T[]
  /** agentId → the agents directly beneath it, with no agent in between. */
  childrenByAgentId: ReadonlyMap<string, readonly T[]>
  /** agentId → its nearest strictly-enclosing agent; absent means root. */
  parentByAgentId: ReadonlyMap<string, T>
}

/**
 * One layer up and one layer down, measured in agents rather than folders — so
 * `projects/a/b/scout` is a direct child of root when no agent sits between.
 *
 * Self-excluding by construction, which is the whole reason this exists rather
 * than reusing {@link groupAppsByAgent}: `resolveNearestAgent` counts an exact
 * path match as a hit. That is right for an app, whose anchor can never occupy
 * an agent's path, and fatal for an agent, which would otherwise resolve to
 * itself and collapse every bucket. The failure is silent — empty rosters, no
 * error — so the guard is structural here, not a check at the call site.
 */
export function groupAgentsByParent<T extends AgentResolutionCandidate>(
  agents: readonly T[],
): AgentHierarchy<T> {
  const rootChildren: T[] = []
  const childrenByAgentId = new Map<string, T[]>()
  const parentByAgentId = new Map<string, T>()
  for (const agent of agents) childrenByAgentId.set(agent.agentId, [])
  for (const agent of agents) {
    // A path the drive grammar rejects has no place in the tree; skipping it
    // keeps one bad row from stranding every other agent's roster.
    if (!normalizeDrivePath(agent.rootPath).ok) continue
    const parent = resolveNearestAgent(
      agent.rootPath,
      agents.filter(candidate => candidate.agentId !== agent.agentId),
    )
    if (parent === null) {
      rootChildren.push(agent)
      continue
    }
    parentByAgentId.set(agent.agentId, parent)
    childrenByAgentId.get(parent.agentId)?.push(agent)
  }
  // Deterministic at the seam, by the one field every candidate has and no two
  // share. Callers still sort for display — the roster by slug — but none of
  // them should inherit the caller's input order, and a helper whose output
  // depends on it makes every downstream test order-sensitive.
  const byRootPath = (left: T, right: T) => (left.rootPath < right.rootPath ? -1 : 1)
  rootChildren.sort(byRootPath)
  for (const children of childrenByAgentId.values()) children.sort(byRootPath)
  return { rootChildren, childrenByAgentId, parentByAgentId }
}

export type AgentAppGroups<T> = {
  root: readonly T[]
  byAgentId: ReadonlyMap<string, readonly T[]>
}

export function groupAppsByAgent<T extends { anchorPath: string }>(
  candidates: readonly AgentResolutionCandidate[],
  apps: readonly T[],
): AgentAppGroups<T> {
  const root: T[] = []
  const byAgentId = new Map<string, T[]>()
  for (const candidate of candidates) byAgentId.set(candidate.agentId, [])
  for (const app of apps) {
    const nearest = resolveNearestAgent(app.anchorPath, candidates)
    if (nearest === null) root.push(app)
    else byAgentId.get(nearest.agentId)?.push(app)
  }
  return { root, byAgentId }
}

// Launch eligibility, owned in one place. Written as an allow-list on 'active'
// rather than a deny-list on 'broken': AnchorStateSchema now also carries
// 'orphaned', so `!== 'broken'` would silently start treating orphaned anchors
// as launchable. A disabled or non-active agent has no folder to run in.
export function agentIsLaunchable(agent: Pick<Agent, 'disabledAt' | 'anchorState'>): boolean {
  return agent.disabledAt === undefined && agent.anchorState === 'active'
}

// The single `id → agentId` / `anchorPath → rootPath` adapter that turns an
// agent row into the shape `resolveNearestAgent` consumes. Server attribution,
// the gateway runtime, and client-side app grouping all route through this so
// the rename lives in exactly one place.
export function agentResolutionCandidate(
  agent: Pick<Agent, 'id' | 'anchorId' | 'anchorPath'>,
): AgentResolutionCandidate {
  return { agentId: agent.id, anchorId: agent.anchorId, rootPath: agent.anchorPath }
}
