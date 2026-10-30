import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useMemo } from 'react'

import {
  DEFAULT_AGENT_NAME,
  type App,
  type SessionListItem,
  type SessionInputSender,
  type SessionSummary,
  type WorkspaceMember,
} from '@repo/contract'

import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { driveFileIconPath } from '../drive/drive-file-icon'
import type { ProjectedMessage } from './projection'
import { findCachedSessionSummary } from './session-cache'
import { sessionQueryOptions } from './session-data'
import { sessionDisplayLabel, shortIdLabel } from './session-lineage'
import { sessionMapHref } from './session-owner'

/**
 * The four classes of author a transcript can name. They are the sender's own
 * kinds: presentation distinguishes them, it never reinvents them.
 */
export type SessionAuthorCategory = SessionInputSender['kind']

/**
 * The identity mark a row wears. A person keeps the product's person portrait;
 * everything else gets its own mark, because a relayed row wearing a human face
 * is the bug this owner exists to prevent.
 */
export type SessionAuthorPortrait =
  | { kind: 'person'; name: string }
  | { kind: 'person-unknown' }
  | { kind: 'person-pending' }
  /** an app that has an icon of its own, addressed by URL */
  | { kind: 'app-icon'; src: string }
  /** every other app: the generic app mark, and where an icon fails to load */
  | { kind: 'app' }
  | { kind: 'session' }
  | { kind: 'duet' }

/** Author vocabulary the product owns in every locale. */
export type SessionAuthorCopy = {
  /** stands in for a human the loaded roster does not know */
  unknownMember: string
  /** stands in for a human whose roster has not arrived yet */
  pendingMember: string
  /** stands in for a sending session whose read has not answered yet */
  pendingSession: string
  app: string
  session: string
  /** how a name and its category read as one announced author */
  withCategory: (input: { name: string; category: string }) => string
}

/**
 * Everything a transcript row needs to name its author, resolved once from
 * current identity. The row renders this; it does not look anything up.
 */
export type SessionAuthorPresentation = {
  category: SessionAuthorCategory
  /** printed beside the portrait */
  label: string
  /** announced as the author, category included when the label alone is ambiguous */
  accessibleLabel: string
  /** the category's own visible word, for the classes that need one */
  categoryLabel?: string
  portrait: SessionAuthorPortrait
  /**
   * Where the reader can go to read this author's own side of the exchange.
   * Only a session has one: an app and a person are not places, and the
   * workspace's own Duet is already here.
   */
  href?: string
  /**
   * The identity this row names is missing from the loaded workspace roster.
   * Only a human sender can be unresolved: a person who wrote a row always has
   * a member row, so its absence is a broken invariant shown as one — and never
   * a reason to show the reader's own name or the internal id.
   */
  unresolved?: true
  /** The roster this row needs has not arrived yet; nothing is wrong. */
  pending?: true
}

/**
 * Current identity by id, for one page. It answers who an id is right now and
 * says nothing about how that reads on screen — every label, fallback, and
 * category belongs to `resolveSessionAuthor`.
 */
export type SessionAuthorDirectory = {
  /** false while the workspace roster is still loading */
  rosterLoaded: boolean
  /**
   * What this workspace calls its own assistant right now. A workspace may
   * rename its Duet, and a system row is that assistant speaking — so the name
   * is workspace identity like every other name here, not product copy.
   */
  duetName: string
  memberName: (userId: string) => string | undefined
  appName: (appId: string) => string | undefined
  /**
   * Where the app's own icon file can be read, when it has one. A URL is
   * identity the page already holds, not a lookup: the browser fetches (and
   * caches) it per unique app, never per transcript row.
   */
  appIconUrl: (appId: string) => string | undefined
  session: (sessionId: string) => SessionAuthorSource | undefined
}

/**
 * What is currently known about a session that authored something here.
 *
 * A session inside an agent speaks AS that agent: "who messaged me" is answered
 * by the agent's name, while the sending conversation's own title says what
 * that agent happened to be working on — which the reader did not ask. A root
 * session has no agent to speak as and keeps its title.
 */
export type SessionAuthorSource = {
  title?: string
  agentName?: string
  /**
   * Where this session can be read, on its own agent's surface. Absent while
   * the owner is unresolved and for a session that is gone — a row that names
   * its author is still true when there is nowhere to go.
   */
  href?: string
  /**
   * This session's read has not answered yet. It matters because the fallback
   * is a short id: without this, a cross-agent row would show the raw id for as
   * long as the request takes and then swap to a name, which is the very thing
   * the id fallback is supposed to be a last resort for.
   */
  pending?: true
}

/** One sending session's read, as the directory currently sees it. */
export type SessionAuthorRead = {
  sessionId: string
  summary?: SessionSummary | SessionListItem
  /** its request is in flight; nothing is known yet and nothing is wrong */
  pending?: boolean
}

/**
 * One lookup table for a whole transcript. It is built from identity the page
 * already holds — the workspace roster, the registered apps, and cached session
 * summaries — so a thousand rows cost the same as one.
 */
export function createSessionAuthorDirectory(sources: {
  /** the signed-in reader, whose own identity never waits on a request */
  viewer?: { id: string; email: string; name?: string }
  /** the workspace roster; `undefined` until it loads, never a shorter list */
  members?: readonly WorkspaceMember[]
  apps?: readonly App[]
  sessions?: ReadonlyMap<string, SessionAuthorSource>
  /** the workspace's name for its assistant; the product default when unset */
  duetName?: string
  /**
   * Turns a workspace file into a URL. Omitted where no workspace file can be
   * served — a hermetic fixture, a test — and an app then keeps the generic
   * mark rather than pointing at a URL nothing answers.
   */
  fileUrl?: (drivePath: string, version: number) => string
}): SessionAuthorDirectory {
  const memberById = new Map(
    [...(sources.viewer === undefined ? [] : [sources.viewer]), ...(sources.members ?? [])].map(
      member => [member.id, member],
    ),
  )
  const appById = new Map((sources.apps ?? []).map(app => [app.id, app]))

  return {
    rosterLoaded: sources.members !== undefined,
    duetName: displayText(sources.duetName) ?? DEFAULT_AGENT_NAME,
    memberName: userId => {
      const member = memberById.get(userId)
      return member === undefined ? undefined : (displayText(member.name) ?? member.email)
    },
    appName: appId => {
      const app = appById.get(appId)
      return displayText(app?.name) ?? displayText(app?.slug)
    },
    appIconUrl: appId => {
      const app = appById.get(appId)
      if (app === undefined) return undefined
      const iconPath = driveFileIconPath(app)
      return iconPath === undefined ? undefined : sources.fileUrl?.(iconPath, app.updatedAt)
    },
    session: sessionId => sources.sessions?.get(sessionId),
  }
}

/**
 * The one place a typed sender becomes an author on screen. A human is named or
 * declared missing — an internal user id is never shown or announced, because an
 * id is not a person and a reader cannot act on one. The other three classes
 * degrade to a stable short id, which for an app or a session is exactly the
 * handle its owner can look up.
 */
export function resolveSessionAuthor(
  sender: SessionInputSender,
  directory: SessionAuthorDirectory,
  copy: SessionAuthorCopy,
): SessionAuthorPresentation {
  switch (sender.kind) {
    case 'user': {
      const name = directory.memberName(sender.userId)
      if (name !== undefined)
        return {
          category: 'user',
          label: name,
          accessibleLabel: name,
          portrait: { kind: 'person', name },
        }
      if (!directory.rosterLoaded)
        return {
          category: 'user',
          // The pending row renders a placeholder bar, not this label — it
          // exists so the presentation shape stays uniform for every row.
          label: copy.pendingMember,
          accessibleLabel: copy.pendingMember,
          portrait: { kind: 'person-pending' },
          pending: true,
        }
      return {
        category: 'user',
        label: copy.unknownMember,
        accessibleLabel: copy.unknownMember,
        portrait: { kind: 'person-unknown' },
        unresolved: true,
      }
    }
    case 'app': {
      const name = directory.appName(sender.appId) ?? shortIdLabel(sender.appId)
      const iconUrl = directory.appIconUrl(sender.appId)
      return {
        category: 'app',
        label: name,
        accessibleLabel: copy.withCategory({ name, category: copy.app }),
        categoryLabel: copy.app,
        // An app that published an icon is recognized by it; one that has none
        // — or that is gone — keeps the generic mark in the same footprint.
        portrait: iconUrl === undefined ? { kind: 'app' } : { kind: 'app-icon', src: iconUrl },
      }
    }
    case 'session': {
      const source = directory.session(sender.sessionId)
      if (source?.pending === true)
        return {
          category: 'session',
          // The row draws a placeholder bar rather than this label; it exists so
          // a screen reader is told a name is coming, not that one is missing.
          label: copy.pendingSession,
          accessibleLabel: copy.pendingSession,
          portrait: { kind: 'session' },
          pending: true,
        }
      const name =
        displayText(source?.agentName) ?? sessionDisplayLabel(sender.sessionId, source?.title)
      return {
        category: 'session',
        label: name,
        accessibleLabel: copy.withCategory({ name, category: copy.session }),
        categoryLabel: copy.session,
        portrait: { kind: 'session' },
        ...(source?.href === undefined ? {} : { href: source.href }),
      }
    }
    case 'system':
      return {
        category: 'system',
        // The workspace's own assistant wrote this, so the row says what this
        // workspace calls it — a renamed Duet is not a different author.
        label: directory.duetName,
        accessibleLabel: directory.duetName,
        portrait: { kind: 'duet' },
      }
  }
}

/** The product's author vocabulary in the reader's language. */
export function useSessionAuthorCopy(): SessionAuthorCopy {
  const t = useTranslations('duetApp.sessionProduct')
  return useMemo(
    () => ({
      unknownMember: t('authorUnknown'),
      pendingMember: t('authorPending'),
      pendingSession: t('authorPendingSession'),
      app: t('authorApp'),
      session: t('authorSession'),
      withCategory: ({ name, category }) => t('authorWithCategory', { name, category }),
    }),
    [t],
  )
}

/**
 * Who each sending session is, keyed by its id. Summaries that never answered
 * — deleted since they wrote, or still in flight — are simply absent, so the
 * row falls back to the short id rather than to a half-built name.
 */
export function sessionAuthorSources(
  workspaceSlug: string,
  reads: readonly SessionAuthorRead[],
  agents: readonly { id: string; slug: string }[] | undefined,
): ReadonlyMap<string, SessionAuthorSource> {
  const sources = new Map<string, SessionAuthorSource>()
  for (const read of reads) {
    const { summary } = read
    if (summary === undefined) {
      // A read still in flight waits; one that answered with nothing — deleted
      // since it wrote here — is absent, and the row falls back to the short id.
      if (read.pending === true) sources.set(read.sessionId, { pending: true })
      continue
    }
    const href = sessionMapHref(workspaceSlug, summary, agents)
    sources.set(read.sessionId, {
      title: summary.title,
      ...(summary.agent === undefined ? {} : { agentName: summary.agent.name }),
      ...(href === undefined ? {} : { href }),
    })
  }
  return sources
}

/**
 * The transcript's directory: one roster read, one bounded lookup per distinct
 * app author, and one read per *distinct sending session*.
 *
 * That last read is the point. Naming a relayed row from cache alone was free
 * and almost always wrong: the session that messaged this one belongs to
 * another agent, so no list this page has loaded contains it, and every
 * delegated row degraded to a raw id. A cross-agent message is rare and its
 * senders are few — the cost is bounded by the distinct senders in view, not by
 * rows — so the read is worth what it buys, exactly as the lineage chip next
 * door already decided for the parent session.
 */
export function useSessionAuthorDirectory(
  workspaceSlug: string,
  messages: readonly ProjectedMessage[] | undefined,
): SessionAuthorDirectory {
  const { api, identity } = useSpa()
  const queryClient = useQueryClient()
  const senders = useMemo(() => addressedIdentities(messages), [messages])
  const members = useQuery(duetQueryOptions.workspaces.members(api, workspaceSlug))
  const apps = useQueries({
    queries: senders.appIds.map(appId => ({
      ...duetQueryOptions.workspaces.appLookup(api, workspaceSlug, { id: appId }),
    })),
    combine: results => results.flatMap(result => result.data?.items ?? []),
  })
  const cached = useMemo(
    () =>
      senders.sessionIds.map(sessionId =>
        findCachedSessionSummary(queryClient, workspaceSlug, sessionId),
      ),
    [queryClient, senders, workspaceSlug],
  )
  const fetched = useQueries({
    queries: senders.sessionIds.map((sessionId, index) => ({
      ...sessionQueryOptions.detail(api, workspaceSlug, sessionId),
      // A session already on this page needs no request, and one that is gone
      // must not be retried into a name it will never have.
      enabled: cached[index] === undefined,
      retry: false,
      /* Naming an author is not a live read. `detail` polls at 1Hz while a
         title is being written or a delivery is in flight, which is right for
         the session you are *looking at* and would be a permanent background
         poll per sender for one that merely wrote here. */
      refetchInterval: false as const,
    })),
    /* Combined here so what comes out has an identity of its own: `useQueries`
       hands back a fresh array every render, and a directory memoised on that
       would be rebuilt for every row in the transcript. `isLoading` rather than
       `isPending`, which a disabled query reports forever. */
    combine: results => results.map(result => ({ data: result.data, loading: result.isLoading })),
  })
  const ownerIds = useMemo(
    () => [
      ...new Set(
        senders.sessionIds.flatMap((_, index) => {
          const id = (cached[index] ?? fetched[index]?.data)?.agent?.id
          return id === undefined ? [] : [id]
        }),
      ),
    ],
    [cached, fetched, senders.sessionIds],
  )
  const ownerAgents = useQueries({
    queries: ownerIds.map(id =>
      duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { id }),
    ),
    combine: results =>
      results.flatMap(result =>
        result.data === undefined || result.data === null ? [] : [result.data],
      ),
  })
  const sessions = useMemo(
    () =>
      sessionAuthorSources(
        workspaceSlug,
        senders.sessionIds.map((sessionId, index) => ({
          sessionId,
          summary: cached[index] ?? fetched[index]?.data,
          pending: fetched[index]?.loading,
        })),
        ownerAgents,
      ),
    [workspaceSlug, senders, cached, fetched, ownerAgents],
  )
  const duetName = identity.workspaces.find(workspace => workspace.slug === workspaceSlug)?.duetName

  return useMemo(
    () =>
      createSessionAuthorDirectory({
        viewer: identity.user,
        members: members.data?.items,
        apps,
        sessions,
        duetName,
        fileUrl: (drivePath, version) =>
          api.workspaceFileDownloadUrl(workspaceSlug, drivePath, { version }),
      }),
    [api, apps, duetName, identity.user, members.data?.items, sessions, workspaceSlug],
  )
}

function addressedIdentities(messages: readonly ProjectedMessage[] | undefined): {
  appIds: string[]
  sessionIds: string[]
} {
  const appIds = new Set<string>()
  const sessionIds = new Set<string>()
  for (const message of messages ?? []) {
    if (message.role !== 'input') continue
    if (message.sender.kind === 'app') appIds.add(message.sender.appId)
    if (message.sender.kind === 'session') sessionIds.add(message.sender.sessionId)
  }
  return { appIds: [...appIds], sessionIds: [...sessionIds] }
}

function displayText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
