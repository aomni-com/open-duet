import { z } from 'zod'

import {
  AgentNameSchema,
  AGENT_TAGS,
  AgentTagSchema,
  MAX_AGENTS_PER_WORKSPACE,
  resolveAgentConfig,
  type AgentTag,
} from '../agents/index'
import { DriveRelativePathSchema } from '../anchors/index'
import {
  AppCommandSchema,
  AppInstallCommandSchema,
  AppNameSchema,
  MAX_APPS_PER_WORKSPACE,
} from '../apps/index'
import { isEdgeHost } from '../edge/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { AppApiScopesSchema } from '../scopes/index'
import { AppSlugSchema, PublishSlugSchema, WorkspaceSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'
import { WorkspaceDuetNameSchema, WorkspacePurposeSchema } from '../workspaces/index'

export const MAX_MARKETPLACE_IDENTIFIER_UTF8_BYTES = 512
export const MAX_MARKETPLACE_SOURCE_URL_UTF8_BYTES = 4_096
export const MAX_MARKETPLACE_LAST_ERROR_CODE_UTF8_BYTES = 256
export const MAX_MARKETPLACE_TITLE_UTF8_BYTES = 600
export const MAX_MARKETPLACE_SUMMARY_UTF8_BYTES = 8 * 1_024
export const MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES = 256 * 1_024
export const MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES = 32 * 1_024
export const MAX_MARKETPLACE_AGENT_JSON_UTF8_BYTES = 64 * 1_024
export const MAX_MARKETPLACE_SKILL_NAME_UTF8_BYTES = 256
export const MAX_MARKETPLACE_LISTING_SKILLS = 64

const MarketplaceIdentifierSchema = utf8BoundedString(
  MAX_MARKETPLACE_IDENTIFIER_UTF8_BYTES,
  'Marketplace identifier',
).min(1)
export const MarketplaceLastErrorCodeSchema = utf8BoundedString(
  MAX_MARKETPLACE_LAST_ERROR_CODE_UTF8_BYTES,
  'Marketplace error code',
).min(1)
export const MarketplaceTitleSchema = utf8BoundedString(
  MAX_MARKETPLACE_TITLE_UTF8_BYTES,
  'Marketplace title',
)
export const MarketplaceSummarySchema = utf8BoundedString(
  MAX_MARKETPLACE_SUMMARY_UTF8_BYTES,
  'Marketplace summary',
)
export const MarketplaceChangelogSchema = utf8BoundedString(
  MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES,
  'Marketplace changelog',
)
export const MarketplaceSkillNameSchema = utf8BoundedString(
  MAX_MARKETPLACE_SKILL_NAME_UTF8_BYTES,
  'Marketplace skill name',
).min(1)

/**
 * Where a marketplace subscription pulls its agent from.
 *
 * `agentSubpath` is the listing's path *below its publish anchor*, and it is
 * the whole reason this type exists. A listing publishes the agent's own
 * anchor, so the publish root IS the agent folder and the subpath is `''`. The
 * official hub instead publishes one parent folder with agents beneath it, so
 * its subpath is the agent's directory name. The public publish route joins the
 * URL suffix below the anchor, so getting this wrong addresses
 * `agents/<name>/<name>` and 404s — see `deriveListingSourceUrl`'s tests.
 */
export interface ListingSourceInput {
  /** Must be one of `EDGE_HOSTS`; callers read it from their deployment config. */
  edgeHost: string
  publisherWorkspaceSlug: string
  publishSlug: string
  /** `''` when the publish anchor is the agent folder itself. */
  agentSubpath: string
}

const SUBPATH_SEGMENT_ERROR =
  'Invalid listing agentSubpath: segments must match the slug grammar (no traversal, no empty segments)'

function subpathSegments(agentSubpath: string): string[] {
  if (agentSubpath === '') return []
  // Deliberately strict rather than normalizing: a subpath that needs cleaning
  // is a malformed listing row, and silently repairing it would hide the bug
  // that wrote it. `..`, `.`, empty segments and percent-encoded traversal all
  // fail the slug grammar.
  const segments = agentSubpath.split('/')
  for (const segment of segments) {
    // Agent folder names carry the app/agent slug grammar (`AppSlugSchema` is
    // what `MarketplaceAgentNameSchema` already reuses), so validating against it
    // keeps one grammar owner rather than inventing a path grammar here.
    if (!AppSlugSchema.safeParse(segment).success) throw new Error(SUBPATH_SEGMENT_ERROR)
  }
  return segments
}

/**
 * The ONE place a marketplace source URL is constructed. Nothing else may
 * concatenate an edge URL — not the catalog, not the gateway puller.
 *
 * The `?zip` selector is part of the derived URL, not something a consumer
 * appends: the archive is the only thing the marketplace ever fetches over
 * HTTP, so baking it in makes "this URL can only request an archive" a property
 * the receiving gateway can check rather than a convention it must follow.
 */
export function deriveListingSourceUrl(input: ListingSourceInput): string {
  if (!isEdgeHost(input.edgeHost)) {
    throw new Error(`Invalid listing edge host: ${input.edgeHost}`)
  }
  const workspaceSlug = WorkspaceSlugSchema.parse(input.publisherWorkspaceSlug)
  const publishSlug = PublishSlugSchema.parse(input.publishSlug)
  const url = new URL(`https://${input.edgeHost}`)
  url.pathname = [workspaceSlug, publishSlug, ...subpathSegments(input.agentSubpath)]
    .map(segment => encodeURIComponent(segment))
    .join('/')
  url.search = 'zip'
  return url.toString()
}

/**
 * Independent re-validation of a URL a process was *handed*. The gateway parses
 * every desired-state entry through this before fetching, so the backend being
 * the sole supplier is not the only thing standing between a VM and an
 * arbitrary host. A host carried beside the URL in the same payload would not
 * be a firewall; this list, compiled into the consumer, is.
 */
export const ListingSourceUrlSchema = utf8BoundedString(
  MAX_MARKETPLACE_SOURCE_URL_UTF8_BYTES,
  'Listing source URL',
).superRefine((value, ctx) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid listing source URL' })
    return
  }
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (url.protocol !== 'https:') reject('Listing source URL must be https')
  if (!isEdgeHost(url.host)) reject(`Listing source URL host is not an edge host: ${url.host}`)
  if (url.username !== '' || url.password !== '') reject('Listing source URL carries credentials')
  if (url.search !== '?zip') reject('Listing source URL must request ?zip')
  if (url.hash !== '') reject('Listing source URL carries a fragment')
  if (url.pathname.includes('//') || url.pathname.split('/').includes('..')) {
    reject('Listing source URL path is not canonical')
  }
})

// ---- subscription + catalog vocabulary (merged from marketplace) ----

export const MarketplaceAgentNameSchema = AppSlugSchema
export type MarketplaceAgentName = z.infer<typeof MarketplaceAgentNameSchema>

export function marketplaceAgentInstallPath(name: string): `agents/${string}` {
  return `agents/${MarketplaceAgentNameSchema.parse(name)}`
}

export const MarketplaceAgentSubscriptionSchema = z.object({
  id: MarketplaceIdentifierSchema,
  agentId: MarketplaceIdentifierSchema.optional(),
  anchorId: MarketplaceIdentifierSchema.optional(),
  /** The listing this subscription installs. Every subscription has one. */
  listingId: MarketplaceIdentifierSchema,
  /** Display/path cache of the listed agent's slug; the listing owns the truth. */
  agentName: MarketplaceAgentNameSchema,
  path: DriveRelativePathSchema,
  mode: z.enum(['subscribe', 'clone_once']),
  state: z.enum(['installing', 'active', 'error', 'detached']),
  appliedEtag: MarketplaceIdentifierSchema.optional(),
  acknowledgedEtag: MarketplaceIdentifierSchema.optional(),
  lastAppliedAt: z.number().nonnegative().optional(),
  lastErrorCode: MarketplaceLastErrorCodeSchema.optional(),
})

export type MarketplaceAgentSubscription = z.infer<typeof MarketplaceAgentSubscriptionSchema>

export const MarketplaceAgentSubscriptionListQuerySchema = CollectionPageQuerySchema
export const MarketplaceAgentSubscriptionListSchema = collectionPageSchema(
  MarketplaceAgentSubscriptionSchema,
)

export type MarketplaceAgentSubscriptionList = z.infer<
  typeof MarketplaceAgentSubscriptionListSchema
>

/**
 * Which surface asked for an install. Analytics only — it changes nothing
 * about the subscription and is never stored on it, so a future surface can
 * be added here without a migration. The server decides it: `onboarding` and
 * `campaign` are facts about how the request arrived, not claims a browser
 * gets to make, which is why it is absent from the request schemas below.
 */
export const MarketplaceInstallSourceSchema = z.enum(['marketplace', 'onboarding', 'campaign'])
export type MarketplaceInstallSource = z.infer<typeof MarketplaceInstallSourceSchema>

export const MarketplaceAgentInstallRequestSchema = z.object({
  // A LISTING, never a bare agent name: two publishers may list the same name,
  // and the consent the user gave was to one of them specifically.
  listingId: z.string().min(1),
  // What the installer will call this agent. Optional: the dialog always asks,
  // but leaving it blank is an answer — the agent takes the listing's slug, the
  // same name it would have had before anyone was asked. Display metadata only:
  // the agent's slug and path are unaffected, and this never reaches the
  // subscription row.
  name: AgentNameSchema.optional(),
  // Omitted ⇒ canonical `agents/<name>`; present ⇒ the rename-on-collision
  // target the user chose. Either way the install is a subscription.
  path: DriveRelativePathSchema.optional(),
})

export type MarketplaceAgentInstallRequest = z.infer<typeof MarketplaceAgentInstallRequestSchema>

export const MarketplaceAgentCloneRequestSchema = z.object({
  listingId: z.string().min(1),
  path: DriveRelativePathSchema,
})
export type MarketplaceAgentCloneRequest = z.infer<typeof MarketplaceAgentCloneRequestSchema>

export const MarketplaceAgentSubscriptionResponseSchema = z.object({
  subscription: MarketplaceAgentSubscriptionSchema,
})

export type MarketplaceAgentSubscriptionResponse = z.infer<
  typeof MarketplaceAgentSubscriptionResponseSchema
>

export const MarketplaceAgentUninstallResponseSchema = z.object({ ok: z.literal(true) })

export const VmDesiredMarketplaceAgentsSchema = z.object({
  subscriptions: z
    .array(
      z.object({
        subscriptionId: z.string().min(1),
        listingId: z.string().min(1),
        agentName: MarketplaceAgentNameSchema,
        // Derived per subscription and host-validated here; the gateway
        // re-validates before fetching. There is no longer ONE origin for a VM's
        // subscriptions — every listing has its own publisher.
        sourceUrl: ListingSourceUrlSchema,
        path: DriveRelativePathSchema,
        anchorId: z.string().min(1),
        mode: z.enum(['subscribe', 'clone_once']),
        // An OPAQUE token that changes when this listing's served bytes change.
        // The subscriber compares it ONLY against the token it last pulled at —
        // never against an ETag, a hash, or a clock. That is what makes it
        // immune to the ETag's own instability (`zipTreeEtag` hashes mtimeNs,
        // so an identical-bytes rewrite moves it) and what lets a second writer
        // mint a different kind of value later without a wire change.
        // Absent means unknown: revalidate exactly as before.
        contentRevision: MarketplaceIdentifierSchema.optional(),
        // How long to wait between revalidations while the subscriber's OWN
        // predicate says it is already in sync. A value, not a decision: the VM
        // still decides whether it is in sync (only it knows whether its cached
        // snapshot survived) and still clamps this into its own safe range.
        // Here so that retuning the interval is a deploy rather than a fleet
        // release — the same split as `pollAfterMs` on the sync response.
        revalidateAfterMs: z.number().int().positive().optional(),
      }),
    )
    .max(MAX_AGENTS_PER_WORKSPACE),
})

export type VmDesiredMarketplaceAgents = z.infer<typeof VmDesiredMarketplaceAgentsSchema>

export const MarketplaceAgentPullReportSchema = z.discriminatedUnion('state', [
  z.object({
    subscriptionId: MarketplaceIdentifierSchema,
    state: z.literal('active'),
    appliedEtag: MarketplaceIdentifierSchema,
    lastAppliedAt: z.number().nonnegative(),
  }),
  z.object({
    subscriptionId: MarketplaceIdentifierSchema,
    state: z.literal('error'),
    lastErrorCode: MarketplaceLastErrorCodeSchema,
    // WHEN the failure was observed. Without it an error cannot be compared
    // against what the subscription has already applied, so a delayed error
    // generated before a successful pull would arrive after it and knock a
    // healthy subscription back to `error`. Optional because a gateway that
    // predates it still reports usefully; a report with no time is applied, as
    // it was before.
    observedAt: z.number().nonnegative().optional(),
  }),
])
export type MarketplaceAgentPullReport = z.infer<typeof MarketplaceAgentPullReportSchema>

export const MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE = 256

export const MarketplaceAgentPullSuccessSchema = z.object({
  ok: z.literal(true),
  reports: z
    .array(MarketplaceAgentPullReportSchema)
    .max(MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE),
})
export type MarketplaceAgentPullSuccess = z.infer<typeof MarketplaceAgentPullSuccessSchema>

export const MarketplaceAgentPullFailureSchema = z.object({
  error: z.literal('pull_failed'),
  reports: z
    .array(MarketplaceAgentPullReportSchema)
    .max(MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE),
})
export type MarketplaceAgentPullFailure = z.infer<typeof MarketplaceAgentPullFailureSchema>

export const MarketplaceAgentMutationErrorSchema = z.discriminatedUnion('error', [
  z.object({
    error: z.literal('path_exists'),
    path: DriveRelativePathSchema,
    renameRequired: z.literal(true),
  }),
  z.object({ error: z.literal('agent_limit_exceeded') }),
  z.object({ error: z.literal('pull_failed') }),
  z.object({ error: z.literal('install_failed') }),
  // The listing exists but its origin is not serving; installing would create a
  // subscription that can only ever fail to pull. Refuse loudly instead.
  z.object({ error: z.literal('listing_unavailable') }),
  // Unlisted or taken down: no longer installable, existing installs untouched.
  z.object({ error: z.literal('listing_removed') }),
])
export type MarketplaceAgentMutationError = z.infer<typeof MarketplaceAgentMutationErrorSchema>

// Both onboarding shapes carry the same completion payload: the assistant's
// name, the optional composed purpose, and the analytics-only goal id
// (`<goalId>` or 'custom') — the goal is never stored on the workspace.
const WorkspaceOnboardingCompletionSchema = z.object({
  duetName: WorkspaceDuetNameSchema,
  purpose: WorkspacePurposeSchema.optional(),
  goal: z.string().trim().min(1).max(100).optional(),
})

export const WorkspaceOnboardingRequestSchema = z.union([
  WorkspaceOnboardingCompletionSchema.extend({
    selectedNames: z
      .array(MarketplaceAgentNameSchema)
      .max(MAX_AGENTS_PER_WORKSPACE)
      .refine(names => new Set(names).size === names.length),
  }),
  WorkspaceOnboardingCompletionSchema.extend({ skip: z.literal(true) }),
])
export type WorkspaceOnboardingRequest = z.infer<typeof WorkspaceOnboardingRequestSchema>

const MarketplaceAgentsOnboardingResultSchema = z.discriminatedUnion('ok', [
  z.object({
    name: MarketplaceAgentNameSchema,
    ok: z.literal(true),
    subscription: MarketplaceAgentSubscriptionSchema,
  }),
  z.object({
    name: MarketplaceAgentNameSchema,
    ok: z.literal(false),
    // The user never chose this agent — a campaign did — so a failure here is
    // not theirs to act on and must not become a message during registration.
    campaign: z.literal(true).optional(),
    failure: MarketplaceAgentMutationErrorSchema,
  }),
])

export const WorkspaceOnboardingResponseSchema = z.object({
  duetName: WorkspaceDuetNameSchema,
  onboardedAt: z.number().int().positive(),
  results: z.array(MarketplaceAgentsOnboardingResultSchema).max(MAX_AGENTS_PER_WORKSPACE),
  pullError: z.literal('pull_failed').optional(),
})

export type WorkspaceOnboardingResponse = z.infer<typeof WorkspaceOnboardingResponseSchema>

// ---- listing eligibility + metadata derivation ----

/**
 * What the gateway observed at a listing's origin: the bounded facts needed to
 * decide eligibility and derive catalog metadata, and nothing else. Deliberately
 * NOT the file tree — an inspector that returned every entry would tempt callers
 * into re-deriving the serving floor a second time.
 */
export interface ListingOriginSnapshot {
  /** The agent's display name, used as the derived title. */
  agentDisplayName: string
  agentsMd: string
  changelogMd: string | null
  /** Directory names under `.agents/skills`, already sorted. */
  skills: string[]
  /**
   * Raw `agent.json` text, or null when the agent has none.
   *
   * Raw rather than parsed on purpose: a snapshot transports authored bytes,
   * and a producer that pre-parses becomes a second interpreter of the config.
   * `deriveListingMetadata` is the only reader.
   */
  agentJson: string | null
}

const SKILLS_PREFIX = '.agents/skills/'

/**
 * The ONE rule for "which skills does this agent have", shared by every
 * producer of a `ListingOriginSnapshot`.
 *
 * There are two producers — the gateway inspecting a remote folder, and the
 * seed package reading its own generated bytes — and they see different things:
 * the gateway enumerates both directories and files, the seed only ever has
 * file paths because bytes are all it stores.
 *
 * **A skill is a DIRECTORY.** Kind is a required input rather than inferred,
 * because inferring it silently forks the two producers: a stray regular file
 * at `.agents/skills/notes` would become a skill for whoever passed file paths
 * and not for whoever passed directories, and the same agent would advertise
 * different skills depending on who published it. So a directory names a skill
 * directly, and a file only names one through the directory it sits inside.
 *
 * Only the immediate child counts; a nested directory inside one is that
 * skill's own content.
 */
export function skillNamesFromAgentPaths(
  entries: Iterable<{ relativePath: string; kind: 'file' | 'directory' }>,
): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.relativePath.startsWith(SKILLS_PREFIX)) continue
    const rest = entry.relativePath.slice(SKILLS_PREFIX.length).split('/')
    const name = rest[0]
    if (name === undefined || name === '') continue
    // A file is only evidence of a skill when something contains it.
    if (entry.kind === 'file' && rest.length < 2) continue
    names.add(name)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export interface ListingDerivedMetadata {
  title: string
  summary: string
  skills: string[]
  changelog: string
  tags: AgentTag[]
}

export const ListingDerivedMetadataSchema = z.object({
  title: MarketplaceTitleSchema.min(1),
  summary: MarketplaceSummarySchema.min(1),
  skills: z.array(MarketplaceSkillNameSchema).max(MAX_MARKETPLACE_LISTING_SKILLS),
  changelog: MarketplaceChangelogSchema,
  tags: z
    .array(AgentTagSchema)
    .max(AGENT_TAGS.length)
    .refine(tags => new Set(tags).size === tags.length),
})

/**
 * The first prose paragraph of a markdown document, or null when there is none.
 *
 * Moved here from the API's catalog service, where it was a private function
 * that THREW — which meant an agent with no description paragraph presented as
 * a catalog outage (a 502) rather than as a listing that cannot be registered.
 * Returning null lets registration refuse it with a typed error instead.
 */
export function firstMarkdownParagraph(markdown: string): string | null {
  const blocks = markdown.replaceAll('\r\n', '\n').split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    // A block of nothing but headings is a section title, not a description.
    if (lines.every(line => /^#{1,6}(?:\s|$)/.test(line))) continue
    const paragraph = lines.join(' ').replaceAll(/\s+/g, ' ').trim()
    if (paragraph.length > 0) return paragraph
  }
  return null
}

/**
 * Derived (never override) catalog metadata for a listing.
 *
 * The title is the agent's display name rather than a slice of the paragraph:
 * one paragraph cannot unambiguously yield both a title and a summary, and
 * truncating prose into a title reads worse than the name the publisher already
 * chose.
 */
export function deriveListingMetadata(
  origin: ListingOriginSnapshot,
):
  | ListingDerivedMetadata
  | { error: 'listing_missing_description' | 'listing_metadata_too_large' } {
  const summary = firstMarkdownParagraph(origin.agentsMd)
  if (summary === null) return { error: 'listing_missing_description' }
  const derived = {
    title: origin.agentDisplayName,
    summary,
    skills: [...origin.skills].sort((left, right) => left.localeCompare(right)),
    changelog: origin.changelogMd ?? '',
    // The single place authored tags become vocabulary. `resolveAgentConfig`
    // fails open, so a malformed `agent.json` costs the listing its tags and
    // nothing else — never the listing itself.
    tags: resolveAgentConfig(origin.agentJson ?? undefined).tags,
  }
  const parsed = ListingDerivedMetadataSchema.safeParse(derived)
  return parsed.success ? parsed.data : { error: 'listing_metadata_too_large' }
}

// ---- catalog wire ----

export const MarketplaceListingSummarySchema = z.object({
  id: MarketplaceIdentifierSchema,
  publisherSlug: WorkspaceSlugSchema,
  // Publisher-scoped, never per listing: the consent sheet is shown for
  // UNVERIFIED publishers, and trust is granted to whoever published.
  verifiedPublisher: z.boolean(),
  agentName: MarketplaceAgentNameSchema,
  title: MarketplaceTitleSchema,
  summary: MarketplaceSummarySchema,
  skills: z.array(MarketplaceSkillNameSchema).max(MAX_MARKETPLACE_LISTING_SKILLS),
  /* Already normalized by `deriveListingMetadata`; the catalog filters on
     these and never re-decides what a tag is.

     Tolerant on READ so the field can ship without an ordering constraint:
     web and api are separately deployed Vercel projects, so there is always a
     window where a newer SPA is parsing an older API's response. Required
     here, that window renders the marketplace's error state instead of the
     catalog. This is not a compatibility shim for legacy data — it is what
     removes a deploy-order dance rather than creating one. */
  tags: z
    .array(AgentTagSchema)
    .max(AGENT_TAGS.length)
    .refine(tags => new Set(tags).size === tags.length)
    .optional()
    .default([]),
  /* Display names of the apps a subscriber would gain — browsing metadata, not
     the declarations (those stay on the detail's `apps`, where consent reads
     them). Tolerant on READ for the same deploy-order reason as `tags`. */
  appNames: z.array(AppNameSchema).max(MAX_APPS_PER_WORKSPACE).optional().default([]),
  installs: z.number().nonnegative(),
  availability: z.enum(['available', 'unavailable']),
})

export type MarketplaceListingSummary = z.infer<typeof MarketplaceListingSummarySchema>

export const MarketplaceCatalogQuerySchema = CollectionPageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  tag: AgentTagSchema.optional(),
  availability: z.enum(['available', 'unavailable']).optional(),
  verifiedPublisher: z
    .enum(['true', 'false'])
    .transform(value => value === 'true')
    .optional(),
})
export const MarketplaceCatalogResponseSchema = collectionPageSchema(
  MarketplaceListingSummarySchema,
  z.object({ canPublishListings: z.boolean() }),
)
export type MarketplaceCatalogResponse = z.infer<typeof MarketplaceCatalogResponseSchema>

export const MarketplaceListingDetailSchema = MarketplaceListingSummarySchema.extend({
  changelog: MarketplaceChangelogSchema,
  // What a subscriber would actually RUN. The consent sheet is the only place
  // a user is told a stranger gets bash on their VM, so it is shown the real
  // declarations rather than a summary of them.
  apps: z
    .array(
      z.object({
        path: DriveRelativePathSchema,
        command: AppCommandSchema,
        installCommand: AppInstallCommandSchema.optional(),
        apiScopes: AppApiScopesSchema,
      }),
    )
    .max(MAX_APPS_PER_WORKSPACE),
})
export type MarketplaceListingDetail = z.infer<typeof MarketplaceListingDetailSchema>

// ---- gateway inspection wire ----

const ListingOriginSnapshotWireSchema = z.object({
  agentsMd: utf8BoundedString(MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES, 'AGENTS.md'),
  changelogMd: MarketplaceChangelogSchema.nullable(),
  skills: z.array(MarketplaceSkillNameSchema).max(MAX_MARKETPLACE_LISTING_SKILLS),
  // Optional on the wire, not in the type: a gateway that predates tags sends
  // no field, and an inspection from one must still register a listing.
  agentJson: utf8BoundedString(MAX_MARKETPLACE_AGENT_JSON_UTF8_BYTES, 'agent.json')
    .nullable()
    .optional(),
})
export type ListingOriginSnapshotWire = z.infer<typeof ListingOriginSnapshotWireSchema>

export const MarketplaceInspectionResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    entries: z.number().nonnegative(),
    bytes: z.number().nonnegative(),
    origin: ListingOriginSnapshotWireSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['listing_too_large', 'listing_source_invalid', 'gateway_unavailable']),
  }),
])

export const MarketplaceListingCreateRequestSchema = z.object({
  agentSlug: MarketplaceAgentNameSchema,
  // AGENTS.md is a system prompt, not marketing copy, so a caller registering
  // an agent may pass explicit display text. Absent means "derive it".
  title: MarketplaceTitleSchema.min(1).optional(),
  summary: MarketplaceSummarySchema.min(1).optional(),
})
export type MarketplaceListingCreateRequest = z.infer<typeof MarketplaceListingCreateRequestSchema>

export const MarketplaceListingRefusalSchema = z.object({
  error: z.enum([
    'publishing_disabled',
    'listing_anchor_subscribed',
    'listing_already_exists',
    'reserved_title',
    'listing_not_found',
    'listing_too_large',
    'listing_source_invalid',
    'listing_missing_description',
    'listing_metadata_too_large',
    'gateway_unavailable',
  ]),
})

export const MarketplaceListingCreateResponseSchema = z.object({
  listing: z.object({ _id: z.string().min(1) }).loose(),
})

export const MarketplaceUnlistResponseSchema = z.object({ ok: z.literal(true) })
