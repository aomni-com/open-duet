'use client'

import { ArrowLeft, BracketsCurly, CircleNotch, SidebarSimple } from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router'

import {
  agentIsLocked,
  DRIVE_UPLOAD_MAX_BYTES,
  ROOT_AGENT_SCOPE,
  type Agent,
  type AgentStartSessionRequestInput,
  type DefaultSessionMessageRequestInput,
  type AgentPromptBehavior,
  type AgentTurnQuestion,
  type ModelSelectionId,
  type ModelTierId,
  type SpendRefusal,
  type WorkspaceCreditRecovery,
} from '@repo/contract'
import { CelebrationBurst, CONFETTI_FALL_MS } from '@repo/ui/components/common/full-screen-confetti'
import { PrettyObject } from '@repo/ui/components/common/pretty-object'
import type { ComposeBarSessionQuestionSelection } from '@repo/ui/components/compose-bar'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/shadcn/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../agents/agent-avatar'
import { DuetApiError } from '../api/client'
import { duetMutationKeys, duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import { AppFrameBody } from '../apps/app-frame'
import { AppIcon, appDisplayName } from '../apps/app-icon'
import { useSpa } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import {
  useOnboardingWatch,
  type OnboardingCompleteNavigationState,
} from '../drive/agent-onboarding-watch'
import { SpendRefusalNotice, spendRefusalOf } from '../entitlements/spend-refusal'
import { useStorageFullNotifier } from '../entitlements/storage-warning'
import { RestFileSystemProvider } from '../files/lib/rest-provider'
import { formatBytes } from '../format'
import { LoadingHandoff } from '../loading/loading-handoff'
import {
  buildTierQualityOptions,
  buildAdvancedQualityOptions,
} from '../model-tiers/tier-quality-options'
import { RelayStatus } from '../relay/relay-status'
import { useComposePlaceholder } from '../sessions/compose-placeholder'
import { useScheduledReminderLabel } from '../sessions/compose-scheduled-reminder'
import { composeSessionFromApi } from '../sessions/compose-session'
import { handOffComposerDraft, takeComposerDraft } from '../sessions/composer-handoff'
import {
  defaultChatAgentSlug,
  defaultChatCreatedId,
  defaultChatMount,
  defaultChatOwnerKey,
  defaultChatQueryOptions,
  invalidateDefaultChatPointer,
  stampDefaultChat,
} from '../sessions/default-chat'
import { agentFirstMessageProjection, type ProjectedMessage } from '../sessions/projection'
import { agentIdentityFromProfile, sessionAgentIdentity } from '../sessions/session-agent'
import { useSessionAgents } from '../sessions/session-agents'
import {
  useSessionAttachments,
  type SessionAttachmentPayload,
  type SessionAttachmentDraft,
  type SessionAttachmentSnapshot,
  type SessionAttachmentErrorLabels,
  type SessionAttachmentLabels,
} from '../sessions/session-attachments'
import {
  audienceRequest,
  audienceRequestKey,
  SessionAudiencePicker,
  type SelectedAudienceMember,
  type SessionAudienceMode,
} from '../sessions/session-audience-picker'
import {
  createSessionAuthorDirectory,
  useSessionAuthorDirectory,
} from '../sessions/session-authors'
import {
  refreshCreatedSessionCollections,
  seedCreatedSessionCache,
} from '../sessions/session-cache'
import {
  SessionComposer,
  type SessionComposerMode,
  type SessionComposerSubmitPayload,
} from '../sessions/session-composer'
import { useSessionActions, useSessionDetail, useViewerInputSender } from '../sessions/session-data'
import { SessionFileViewerProvider } from '../sessions/session-file-viewer'
import { SessionIntro } from '../sessions/session-intro'
import { SessionLineageChip } from '../sessions/session-lineage-chip'
import { SessionDetailSkeleton } from '../sessions/session-loading'
import { type SessionAgentIdentity } from '../sessions/session-message'
import { resolveSessionOwner, sessionOwnerConfigAgent } from '../sessions/session-owner'
import { useSessionPaneApp } from '../sessions/session-pane-app'
import {
  serializeSessionQuestionAnswers,
  supportsQuestionOptionPanel,
} from '../sessions/session-question-answer'
import { useSessionSkills } from '../sessions/session-skills'
import { VirtualizedSessionTimeline } from '../sessions/virtualized-session-timeline'
import { useToast } from '../shell/toast'
import { appDisplayStatus } from '../status/entity-status'

const EMPTY_AGENTS: readonly Agent[] = []
/* Exported for the map's agent surface, which renders the same conversation and
   must fall back to the same tier when a workspace has no default. */
export const DEFAULT_SESSION_TIER: ModelSelectionId = 'balanced'

const noop = () => {}
const rejectPendingSubmit = async () => 'rejected' as const
const pendingImageUrl = () => 'about:blank'

export function onboardingCompletionFromRouterState(
  state: unknown,
  requestedAgentSlug: string | null,
): OnboardingCompleteNavigationState['onboardingComplete'] | undefined {
  if (
    typeof state !== 'object' ||
    state === null ||
    !('onboardingComplete' in state) ||
    typeof state.onboardingComplete !== 'object' ||
    state.onboardingComplete === null
  ) {
    return undefined
  }
  const completion = state.onboardingComplete as Record<string, unknown>
  return typeof completion.agentId === 'string' &&
    typeof completion.agentSlug === 'string' &&
    typeof completion.agentName === 'string' &&
    completion.agentSlug === requestedAgentSlug
    ? {
        agentId: completion.agentId,
        agentSlug: completion.agentSlug,
        agentName: completion.agentName,
      }
    : undefined
}

export function isConfirmedSubmissionRejection(error: unknown): boolean {
  return error instanceof DuetApiError && error.status >= 400 && error.status < 500
}

export function sessionDetailIsLoading(state: {
  snapshotPending: boolean
  snapshotError: boolean
  historyPending: boolean
  historyError: boolean
}): boolean {
  return (
    (state.snapshotPending || state.historyPending) && !state.snapshotError && !state.historyError
  )
}

export function sessionTimelineCwd(input: {
  sessionId: string | undefined
  persistedCwd: string | undefined
  pendingCwd: string | undefined
}): string | undefined {
  return input.sessionId === undefined ? input.pendingCwd : input.persistedCwd
}

type SessionRequestIdentity = {
  mode?: SessionComposerMode
  text: string
  tier?: ModelSelectionId
  behavior?: AgentPromptBehavior
  cwd?: string
  attachmentsKey: string
  audienceKey?: string
}

export function reuseSessionClientRequestId(
  previous: (SessionRequestIdentity & { id: string }) | undefined,
  current: SessionRequestIdentity,
  createId: () => string = () => crypto.randomUUID(),
): string {
  if (previous === undefined) return createId()
  return previous.mode === current.mode &&
    previous.text === current.text &&
    previous.tier === current.tier &&
    previous.behavior === current.behavior &&
    previous.cwd === current.cwd &&
    previous.attachmentsKey === current.attachmentsKey &&
    previous.audienceKey === current.audienceKey
    ? previous.id
    : createId()
}

function useSessionAttachmentOptions(workspaceSlug: string) {
  const t = useTranslations('duetApp.sessionProduct')
  const notifyStorageFull = useStorageFullNotifier(workspaceSlug)
  const showToast = useToast()
  const errorLabels = useMemo<SessionAttachmentErrorLabels>(
    () => ({
      default: t('uploadFailed'),
      workspace_paused: t('workspacePausedUpload'),
      workspace_provisioning: t('workspaceProvisioningUpload'),
      workspace_archived: t('workspaceArchivedUpload'),
      storage_full: t('storageFullUpload'),
      // The number comes from the constant the refusal is measured against, so
      // the copy cannot drift from the rule.
      file_too_large: t('fileTooLargeUpload', {
        limit: formatBytes(DRIVE_UPLOAD_MAX_BYTES, 1000),
      }),
    }),
    [t],
  )
  const labels = useMemo<SessionAttachmentLabels>(
    () => ({
      uploading: percent => t('uploadingAttachment', { percent }),
      ready: t('attachmentReady'),
      moving: t('movingAttachment'),
      preparing: t('preparingAttachment'),
    }),
    [t],
  )
  const onError = useCallback(
    (error: unknown) => notifyStorageFull({ kind: 'file', error }),
    [notifyStorageFull],
  )
  const onTooMany = useCallback(
    () => showToast({ message: t('tooManyAttachments'), tone: 'warning' }),
    [showToast, t],
  )
  return { errorLabels, labels, onError, onTooMany }
}

// Icon tones for the compose-bar session panel: the same state hues every other
// surface draws a session in (globals.css, `palette.ts`). Waiting on the reader
// is the ask tone, work in flight is live, and a session asleep on a clock is
// resting, so it stays muted rather than borrowing a hue of its own.
const SESSION_STATUS_TONES = {
  waiting: 'text-ask',
  sleeping: 'text-muted-foreground',
  working: 'text-live',
} as const

export function isLocalSessionDebugHost(hostname: string | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/**
 * A draft the reader can keep writing while the last one is still sending.
 *
 * Sending empties the draft rather than freezing it, so whatever is typed
 * while the request travels is the next message. A failed send puts its text
 * back ahead of those words instead of over them.
 */
function useSubmissionDraft() {
  const [value, setValue] = useState('')
  // What the reader has written by now, for a send that settles long after
  // the render that started it.
  const latest = useRef(value)
  latest.current = value
  const editorUpdatesMuted = useRef(false)
  const [settleRevision, setSettleRevision] = useState(0)

  useEffect(() => {
    if (settleRevision === 0) return
    // TipTap echoes the value it held until the controlled one has painted —
    // the sent text after a clear, a blank after a restore. Mute it for exactly
    // that frame, then hand the editor back to the reader.
    const frame = requestAnimationFrame(() => {
      editorUpdatesMuted.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [settleRevision])

  const replace = (next: (current: string) => string) => {
    editorUpdatesMuted.current = true
    setValue(next)
    setSettleRevision(revision => revision + 1)
  }

  return {
    value,
    read: () => latest.current,
    acceptEditorValue: (nextValue: string) => {
      if (!editorUpdatesMuted.current) setValue(nextValue)
    },
    beginSubmission: () => replace(() => ''),
    restoreSubmission: (submittedValue: string) =>
      // Also the path for a draft restored into an editor still mounting —
      // arriving at /sessions/new with a prompt in route state — whose first
      // update is the blank it started as; the mute keeps that from winning.
      replace(current => restoredDraft(submittedValue, current)),
    reset: (initial = '') => {
      if (initial.length > 0) {
        replace(() => initial)
        return
      }
      editorUpdatesMuted.current = false
      setValue('')
    },
  }
}

type SessionDraftInput = Pick<ReturnType<typeof useSubmissionDraft>, 'value' | 'acceptEditorValue'>

/**
 * Takes the draft's files for a send, before the words are cleared: the
 * snapshot a render gated Send on can trail the draft (a re-home can start in
 * between), and a refusal here must leave the whole draft where it was.
 */
function takeSubmittedAttachments(
  attachments: Pick<SessionAttachmentDraft, 'beginSubmission'>,
): SessionAttachmentPayload | undefined {
  try {
    return attachments.beginSubmission()
  } catch {
    return undefined
  }
}

/**
 * Words or files: either one is a message. Files still uploading are not yet
 * part of it, so they hold Send until they land.
 */
function draftCanSend(text: string, attachments: SessionAttachmentSnapshot): boolean {
  return !attachments.busy && (text.trim().length > 0 || attachments.items.length > 0)
}

/**
 * Sends once, and once more — the identical request under the same id — when
 * the first attempt failed without a verdict and the reader kept writing.
 *
 * A failed send returns to the draft ahead of whatever was written during it,
 * and that merged draft is a different request with a fresh id. If the server
 * had in fact accepted the first one, the reader's next Send would deliver it
 * twice. Replaying it verbatim settles that first: the server deduplicates an
 * accepted request by its id, and delivers one that never arrived. A refusal
 * is a verdict, and an untouched draft is already the identical retry.
 */
export async function sendReplayingUnknownOutcome<T>(
  attempt: () => Promise<T>,
  wroteMeanwhile: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (isConfirmedSubmissionRejection(error) || !wroteMeanwhile(error)) throw error
    return await attempt()
  }
}

/** A failed send's text, ahead of anything written while it was in flight. */
export function restoredDraft(submitted: string, writtenSince: string): string {
  if (writtenSince.trim().length === 0) return submitted
  if (submitted.trim().length === 0) return writtenSince
  return `${submitted}\n\n${writtenSince}`
}

function useRouteLifetime() {
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  return active
}

/**
 * Where this surface sends the reader when there is nothing left here to show —
 * an owner the surface cannot resolve. The host answers with its own place;
 * the map answers with the ring.
 */
export type SessionsRouting = {
  exit: (workspaceSlug: string) => string
}

/** Conversation surface shared by Build default chats, onboarding, and Work. */
export function SessionsProduct({
  workspaceSlug,
  sessionId,
  defaultChat = false,
  defaultChatArchivedAt,
  duetName,
  defaultTier,
  agentSlug,
  routes,
  pane = false,
  startJob = false,
  onStarted,
  creditRecovery,
  loadingFallback,
}: {
  workspaceSlug: string
  sessionId?: string
  /**
   * This surface *is* the owner's default chat, rather than one conversation
   * among its many.
   *
   * The owner is the agent named by `agentSlug`, or the drive root when there
   * is none. Turning this on changes both ends of the surface: the conversation
   * it opens is resolved from the `…/sessions/default` alias instead of from an
   * id the host supplies, and a first message is sent through that same alias,
   * which is what stamps the owner's pointer at it (sessions-and-jobs, D27).
   * Both halves are needed — reading the alias while creating through the
   * ordinary path would resolve to nothing forever, because nothing would ever
   * write the pointer.
   */
  defaultChat?: boolean
  /**
   * When the host last archived this owner's default chat, if it has.
   *
   * The host owns the gesture — the control is in the header it draws, not in
   * this surface — and this is the only thing the surface needs to hear about
   * it: the id its own first message minted is about a conversation that is no
   * longer the default, so it must stop holding the panel on it. Nothing else
   * here changes; the alias refetch answers `null` and the empty chat comes
   * back on its own.
   */
  defaultChatArchivedAt?: number
  duetName: string
  defaultTier: ModelSelectionId
  /** which agent's surface this is; the drive root when absent */
  agentSlug?: string
  /** where this surface sends you when the agent cannot be resolved */
  routes: SessionsRouting
  /**
   * Whether this conversation may open its session's app beside itself.
   *
   * Work's conversation says yes — it is the host wide enough, and the one
   * whose subject is a single piece of work. Build's agent panel says no: it
   * already shows the agent's apps beside the thread, and a second copy of one
   * wedged into the chat column would say the same thing smaller.
   */
  pane?: boolean
  /**
   * Start a *job* for this owner: an empty composer whose first message mints
   * an ordinary session attributed to the agent, leaving the owner's pointer
   * alone. `onStarted` gives the host the new conversation's id for navigation.
   *
   * Distinct from `defaultChat`, which composes the owner's *chat* and stamps
   * the pointer. The two look identical on screen and mean opposite things.
   */
  startJob?: boolean
  onStarted?: (sessionId: string) => void
  creditRecovery: WorkspaceCreditRecovery
  /** Lets a host preserve its own shell geometry while session history resolves. */
  loadingFallback?: ReactNode
}) {
  const t = useTranslations('duetApp')
  const navigate = useNavigate()
  const location = useLocation()
  const { api } = useSpa()
  // The host names the owner by slug (`root` for the drive's own chat). The web
  // app never sends an agentId — it resolves the slug to an anchor `cwd` and
  // lets the server attribute (D3, D17).
  const requestedAgent = agentSlug ?? null
  const defaultAgentSlug = defaultChatAgentSlug(requestedAgent)
  /* ---- the default chat is mounted here, not navigated to ----
     The map panel *is* the agent, so its default chat has to appear in the
     panel: resolution decides what to mount, and the URL never changes — the
     place was already the agent. */
  const defaultChatQuery = useQuery({
    ...defaultChatQueryOptions(api, workspaceSlug, defaultAgentSlug),
    enabled: defaultChat,
  })
  /* The id the first message just minted, held until the read agrees.
     Stamped with the owner it belongs to rather than stored bare, because a
     host can swap the conversation underneath a live instance — flying from one
     face to another, or archiving this chat — and a bare id would then hold the
     panel on a conversation that is no longer the one it is about. See
     `defaultChatOwnerKey`. */
  const [created, setCreated] = useState<{
    owner: string
    sessionId: string
  }>()
  const ownerKey = defaultChatOwnerKey(workspaceSlug, defaultAgentSlug, defaultChatArchivedAt)
  const mount = defaultChatMount({
    isPending: defaultChatQuery.isPending,
    session: defaultChatQuery.data,
    created: defaultChatCreatedId(created, ownerKey),
    error: defaultChatQuery.error ?? undefined,
  })
  const mountedSessionId = defaultChat
    ? mount.kind === 'session'
      ? mount.sessionId
      : undefined
    : sessionId
  const completionFromNavigation = onboardingCompletionFromRouterState(
    location.state,
    requestedAgent,
  )
  /* Onboarding completion is one confetti burst, latched on its own timer.
     The navigation state is consumed (stripped by a replace) so a refresh
     cannot re-trigger it, and the latch — not the consumable state — drives
     the overlay: the burst plays out whole even though consumption clears
     the router state within a render. */
  const [confettiFor, setConfettiFor] = useState<string>()
  const consumedCompletionState = useRef<unknown>(undefined)
  useEffect(() => {
    if (completionFromNavigation === undefined) return
    if (consumedCompletionState.current === location.state) return
    consumedCompletionState.current = location.state
    setConfettiFor(`${completionFromNavigation.agentId}:${location.key}`)
    const { onboardingComplete: _consumed, ...state } = location.state as Record<string, unknown>
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state,
    })
  }, [
    completionFromNavigation,
    location.key,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ])
  useEffect(() => {
    if (confettiFor === undefined) return
    const timer = setTimeout(() => setConfettiFor(undefined), CONFETTI_FALL_MS)
    return () => clearTimeout(timer)
  }, [confettiFor])
  const agentsQuery = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const requestedAgentQuery = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, {
      slug: requestedAgent ?? '',
    }),
    enabled:
      requestedAgent !== null && requestedAgent !== '' && requestedAgent !== ROOT_AGENT_SCOPE,
  })
  const rosterAgents = agentsQuery.data?.items ?? EMPTY_AGENTS
  const agents =
    requestedAgentQuery.data === null || requestedAgentQuery.data === undefined
      ? rosterAgents
      : rosterAgents.some(candidate => candidate.id === requestedAgentQuery.data?.id)
        ? rosterAgents
        : [...rosterAgents, requestedAgentQuery.data]
  // Only the selected agent's authored config can affect this surface, so
  // owner resolution precedes the VM file read.
  const requiresLoadedAgents =
    requestedAgent !== null && requestedAgent !== '' && requestedAgent !== ROOT_AGENT_SCOPE
  const preliminaryOwnerResolution =
    requiresLoadedAgents && requestedAgentQuery.isPending
      ? undefined
      : resolveSessionOwner(agents, requestedAgent)
  const configAgent =
    preliminaryOwnerResolution === undefined
      ? undefined
      : sessionOwnerConfigAgent(preliminaryOwnerResolution)
  const configQueryOptions: Array<ReturnType<typeof agentConfigQueryOptions>> =
    configAgent === undefined ? [] : [agentConfigQueryOptions(api, workspaceSlug, configAgent)]
  const configQueries = useQueries({
    queries: configQueryOptions,
  })
  const ownerConfig = configQueries[0]?.data
  const agentConfigPending = configAgent !== undefined && ownerConfig === undefined
  const ownerResolution =
    preliminaryOwnerResolution === undefined || agentConfigPending
      ? ({ status: 'loading' } as const)
      : preliminaryOwnerResolution.status === 'ready' &&
          preliminaryOwnerResolution.owner.kind === 'agent' &&
          ownerConfig !== undefined &&
          agentIsLocked(preliminaryOwnerResolution.owner.agent, ownerConfig)
        ? ({ status: 'unavailable' } as const)
        : preliminaryOwnerResolution
  const ownerAgent =
    ownerResolution.status === 'ready' && ownerResolution.owner.kind === 'agent'
      ? ownerResolution.owner.agent
      : undefined
  const ownerCwd = ownerAgent?.anchorPath
  // The suggestion comes from the same per-agent config fetch that gates the
  // owner resolution, so the bubble on screen and the text sent with the
  // first message can never come from two different reads. Root has no
  // agent.json home and never greets.
  const suggestedFirstMessage =
    ownerAgent === undefined ? undefined : ownerConfig?.suggestedFirstMessage
  const creation = useSessionCreation(
    workspaceSlug,
    defaultTier,
    ownerCwd,
    // Held in state, because this host stays put: the map has nowhere to read
    // the new id back from, and the URL does not change.
    id => {
      if (defaultChat) setCreated({ owner: ownerKey, sessionId: id })
      /* A job has somewhere to be read back from — its own address — so the
         host is told and the URL becomes the answer, rather than this holding
         an id the way the chat has to. */
      if (startJob) onStarted?.(id)
    },
    defaultAgentSlug,
    suggestedFirstMessage,
    startJob ? 'job' : 'chat',
  )
  const composeAgentIdentity: SessionAgentIdentity | undefined =
    ownerAgent === undefined ? undefined : agentIdentityFromProfile(ownerAgent, workspaceSlug)
  // One SessionConversation instance serves both the in-flight creation (no id
  // yet) and the real session, with no `key` on it, so React reconciles the
  // panel across the empty -> live handoff instead of remounting it (which
  // would re-rasterize the blurred header and flash the whole surface). The
  // pending prompt — not the mutation's isPending — gates the conversation so it
  // never blinks out during the id handoff, and is cleared once the real session
  // is mounted.
  const showConversation = mountedSessionId !== undefined || creation.pendingPrompt !== undefined
  const { clearPending } = creation
  useEffect(() => {
    if (mountedSessionId !== undefined) clearPending()
  }, [mountedSessionId, clearPending])

  /* `compose` is not an error and deliberately falls through to the empty
     chat below: the pointer is stamped by the first message, so every owner
     nobody has written to yet arrives here. Only a read that genuinely failed
     stops the surface. */
  if (defaultChat && mount.kind === 'loading') return <SessionCreationLoading />
  if (defaultChat && mount.kind === 'unavailable') {
    return (
      <DetailState
        title={t('sessionProduct.unavailableTitle')}
        body={t('sessionProduct.unavailableBody')}
        action={
          <button
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}
            onClick={() => {
              void defaultChatQuery.refetch()
            }}
          >
            {t('retry')}
          </button>
        }
      />
    )
  }

  return (
    /* No panel on this surface is a `main`, and a new one must not be either.
       The host already owns the page landmark, so a `main` here is a second
       "main" for a screen reader to choose between.

       They are `div`s rather than `section`s because none of them carries an
       accessible name, and an unnamed `section` is not a landmark either: it
       is a `generic` box some readers still announce. The names live on the
       parts that have them — the timeline is a `role="log"` called "Session
       timeline", the app column an `aside` named after its app, the waits
       labelled `section`s inside `SessionDetailSkeleton`.

       `data-session-conversation` is how anything that has to *find* the
       conversation column finds it. All three of its shells — empty, pending,
       loaded — wear it, so a measurement lands on the same box whichever one
       is up. */
    <section
      className="flex h-full min-h-0 min-w-0 w-full overflow-hidden bg-background"
      data-session-surface="product"
    >
      <CelebrationBurst playing={confettiFor !== undefined && !showConversation} />
      {showConversation ? (
        <SessionConversation
          workspaceSlug={workspaceSlug}
          ownerAgentSlug={defaultAgentSlug}
          agents={agents}
          sessionId={mountedSessionId}
          pendingPrompt={mountedSessionId === undefined ? creation.pendingPrompt : undefined}
          pendingAgentFirstMessage={
            mountedSessionId === undefined ? creation.pendingAgentFirstMessage : undefined
          }
          pendingQuality={creation.pendingQuality}
          defaultTier={defaultTier}
          duetName={duetName}
          pendingCwd={creation.pendingCwd}
          pendingMedia={creation.pendingMedia}
          pendingDraft={creation.prompt}
          pane={pane}
          creditRecovery={creditRecovery}
          loadingFallback={loadingFallback}
        />
      ) : ownerResolution.status === 'loading' ? (
        <SessionCreationLoading />
      ) : ownerResolution.status === 'unavailable' ? (
        <AgentUnavailableState onBack={() => navigate(routes.exit(workspaceSlug))} />
      ) : startJob ? (
        /* The same composer the day-one chat uses, and deliberately so: the
           gesture is identical — say what you want, and the first message mints
           the session. What differs is what it mints, which is the creation
           kind, not the surface. */
        <SessionEmptyChat
          workspaceSlug={workspaceSlug}
          ownerAgentSlug={defaultAgentSlug}
          creation={creation}
          cwd={ownerCwd}
          duetName={duetName}
          agent={composeAgentIdentity}
          placeholder={t('sessionProduct.describeTask', {
            name: composeAgentIdentity?.name ?? duetName,
          })}
          creditRecovery={creditRecovery}
        />
      ) : defaultChat ? (
        /* The owner's one continuous conversation, before its first message: an
           empty chat, not a welcome page. The panel already names the agent;
           the composer sits where it will sit for the rest of the
           conversation's life, and the first message sent through it is what
           mints the session (D27). There is no other entry: a person starts a
           conversation with an agent, and only agents spawn further sessions. */
        <SessionEmptyChat
          workspaceSlug={workspaceSlug}
          ownerAgentSlug={defaultAgentSlug}
          creation={creation}
          cwd={ownerCwd}
          duetName={duetName}
          agent={composeAgentIdentity}
          suggestedFirstMessage={suggestedFirstMessage}
          creditRecovery={creditRecovery}
        />
      ) : null}
    </section>
  )
}

function SessionCreationLoading() {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-background p-8">
      <CircleNotch
        aria-label={t('loadingSession')}
        className="size-6 animate-spin text-muted-foreground"
      />
    </div>
  )
}

function AgentUnavailableState({ onBack }: { onBack: () => void }) {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <DetailState
      title={t('agentUnavailableTitle')}
      body={t('agentUnavailableBody')}
      action={
        <button className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')} onClick={onBack}>
          {t('back')}
        </button>
      }
    />
  )
}

/**
 * Whether this user may hold conversations in this workspace.
 *
 * Shared because `SessionsProduct` is now mounted from two destinations, and a
 * second door to the compose bar must be locked by the same key as the first.
 */
export function useCanUseSessions(workspaceSlug: string): boolean {
  const { identity } = useSpa()
  return identity.scopes.some(
    scope => scope === `ws:${workspaceSlug}:sessions` || scope === `ws:${workspaceSlug}:admin`,
  )
}

export function SessionsAccessDenied() {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <section
      className="flex h-full items-center justify-center bg-background p-8 text-center"
      data-session-surface="access-denied"
    >
      <div className="max-w-sm">
        <h1 className="font-serif text-xl font-normal italic tracking-tight">
          {t('accessDeniedTitle')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('accessDeniedBody')}</p>
      </div>
    </section>
  )
}

/**
 * What a first message starts.
 *
 * `chat` is the conversation you have with an owner — it stamps the owner's
 * pointer. `job` is work you put it to, attributed by anchor folder and leaving
 * the pointer alone. Naming the two apart is what keeps a surface from quietly
 * turning one into the other.
 */
type SessionCreationKind = 'chat' | 'job' | 'work'

type SessionCreationController = ReturnType<typeof useSessionCreation>
export type WorkSessionCreationController = SessionCreationController

function useSessionQualityOptions() {
  const t = useTranslations('duetApp.sessionProduct')
  return useMemo(() => {
    const scoreLabel = (label: string) =>
      label === 'Performance'
        ? t('qualityPerformance')
        : label === 'Intelligence'
          ? t('qualityIntelligence')
          : t('qualityCost')
    const description = (tier: ModelTierId) =>
      t(
        {
          frontier: 'qualityMaxDescription',
          balanced: 'qualityStandardDescription',
          economy: 'qualityEconomyDescription',
        }[tier],
      )
    return {
      options: buildTierQualityOptions(
        label =>
          t({ Max: 'qualityMax', Standard: 'qualityStandard', Economy: 'qualityEconomy' }[label]),
        scoreLabel,
        description,
      ),
      advanced: {
        label: t('qualityAdvanced'),
        options: buildAdvancedQualityOptions(scoreLabel),
      },
    }
  }, [t])
}

/**
 * Owns a first message — the whole of how a person starts a session.
 *
 * Three meanings, and the difference between them is the whole reason this takes a
 * `kind` rather than being two hooks. The composer, the draft, the attachments,
 * the tier, the retry and the pending timeline are identical; what differs is
 * one endpoint and what the send *means*.
 *
 * - `chat` goes through the owner's `…/sessions/default` alias, which mints the
 *   session **and stamps the owner's pointer at it** (D27). That is the
 *   conversation you have with an owner.
 * - `job` goes through `POST /agent/sessions` with the owner's anchor folder as
 *   `cwd`, which is how the server attributes work to an agent. The pointer is
 *   not touched, and must not be: a job is not the owner's chat, and a surface
 *   that started one by moving the pointer would make every new job the chat.
 * - `work` uses that same ordinary-session endpoint. Root conversations omit
 *   `cwd`; agent-owned conversations carry the selected owner's anchor folder.
 *   Neither replaces that owner's default-chat pointer.
 *
 * Lives in SessionsProduct (which never unmounts during the handoff), so the
 * mutation, retry and draft survive as the view swaps from the empty composer
 * to the conversation.
 */
function useSessionCreation(
  workspaceSlug: string,
  defaultTier: ModelSelectionId,
  // The owner's anchor folder; the pending timeline renders it while the id
  // is in flight, and the root owner has none. For a job or agent-owned Work
  // conversation it is also what the server reads to attribute the session.
  ownerCwd: string | undefined,
  onCreated: (id: string) => void,
  agentSlug: string | null,
  // The owner's suggested first message, resolved by the host from the same
  // config read that rendered it. Sent with the first message so history
  // records exactly what was on screen (map D3).
  suggestedFirstMessage: string | undefined,
  kind: SessionCreationKind = 'chat',
) {
  const { api, identity } = useSpa()
  const queryClient = useQueryClient()
  const prompt = useSubmissionDraft()
  const [quality, setQuality] = useState<ModelSelectionId>(defaultTier)
  const creationMessage = useMutation({
    // The owner chat key keeps its archive control shut while the pointer is
    // being stamped. Work has its own key so the surrounding sidebar can draw
    // the not-yet-addressable conversation while this panel draws its timeline.
    mutationKey:
      kind === 'chat'
        ? duetMutationKeys.workspaces.sessions.defaultMessage(
            workspaceSlug,
            agentSlug ?? ROOT_AGENT_SCOPE,
          )
        : duetMutationKeys.workspaces.sessions.creation(
            workspaceSlug,
            kind,
            agentSlug ?? ROOT_AGENT_SCOPE,
          ),
    /* One endpoint or the other, and nothing else about this hook branches. A
       job or agent-owned Work conversation carries the owner's anchor folder so
       the server attributes it to that agent; root Work leaves `cwd` absent. The
       web app still never sends an agentId (D3, D17). */
    mutationFn: (
      input: DefaultSessionMessageRequestInput & Pick<AgentStartSessionRequestInput, 'audience'>,
    ) =>
      kind === 'job' || kind === 'work'
        ? api.createSession(workspaceSlug, {
            prompt: input.prompt,
            ...(input.tier === undefined ? {} : { tier: input.tier }),
            ...(input.behavior === undefined ? {} : { behavior: input.behavior }),
            ...(input.clientRequestId === undefined
              ? {}
              : { clientRequestId: input.clientRequestId }),
            ...(ownerCwd === undefined ? {} : { cwd: ownerCwd }),
            ...(input.images === undefined ? {} : { images: input.images }),
            ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
            ...('audience' in input && input.audience !== undefined
              ? { audience: input.audience }
              : {}),
          })
        : api.sendDefaultSessionMessage(workspaceSlug, agentSlug ?? ROOT_AGENT_SCOPE, input),
  })
  const routeActive = useRouteLifetime()
  const attachmentOptions = useSessionAttachmentOptions(workspaceSlug)
  const attachments = useSessionAttachments({
    workspaceSlug,
    scopeCwd: ownerCwd,
    ...attachmentOptions,
  })
  const creator = useMemo<SelectedAudienceMember>(
    () => ({
      id: identity.user.id,
      email: identity.user.email,
      ...(identity.user.name === undefined ? {} : { name: identity.user.name }),
    }),
    [identity.user.email, identity.user.id, identity.user.name],
  )
  const [audienceMode, setAudienceMode] = useState<SessionAudienceMode>('workspace')
  const [audienceMembers, setAudienceMembers] = useState<SelectedAudienceMember[]>([creator])
  const retryRequest = useRef<
    | {
        text: string
        tier: ModelSelectionId
        behavior: AgentPromptBehavior
        cwd?: string
        attachmentsKey: string
        audienceKey: string
        id: string
      }
    | undefined
  >(undefined)
  const [submission, setSubmission] = useState<string>()
  const [submissionCwd, setSubmissionCwd] = useState<string>()
  const [submissionMedia, setSubmissionMedia] = useState<SessionAttachmentPayload>()
  const [submissionAgentFirstMessage, setSubmissionAgentFirstMessage] = useState<string>()
  // Cleared once the created session is on screen (see SessionsProduct). Kept
  // set through a successful send so the conversation stays mounted across the
  // id handoff instead of blinking out for a render.
  const clearPending = useCallback(() => {
    setSubmission(undefined)
    setSubmissionCwd(undefined)
    setSubmissionMedia(undefined)
    setSubmissionAgentFirstMessage(undefined)
  }, [])
  const submit = async ({
    value,
    qualityId = quality,
    behavior,
  }: SessionComposerSubmitPayload<ModelSelectionId>) => {
    const text = value.trim()
    if (!draftCanSend(text, attachments) || behavior === undefined) return 'rejected' as const
    const clientRequestId = reuseSessionClientRequestId(retryRequest.current, {
      text,
      tier: qualityId,
      behavior,
      cwd: ownerCwd,
      attachmentsKey: attachments.key,
      audienceKey: audienceRequestKey(
        audienceMode,
        creator.id,
        audienceMembers.map(member => member.id),
      ),
    })
    retryRequest.current = {
      text,
      tier: qualityId,
      behavior,
      cwd: ownerCwd,
      attachmentsKey: attachments.key,
      audienceKey: audienceRequestKey(
        audienceMode,
        creator.id,
        audienceMembers.map(member => member.id),
      ),
      id: clientRequestId,
    }
    const agentFirstMessage = suggestedFirstMessage
    const media = takeSubmittedAttachments(attachments)
    if (media === undefined) return 'rejected' as const
    prompt.beginSubmission()
    setSubmission(text)
    setSubmissionCwd(ownerCwd)
    setSubmissionMedia(media)
    setSubmissionAgentFirstMessage(agentFirstMessage)
    // The URL names the agent and nothing else rides along: no agentId and no
    // cwd in the payload — attribution is the server's, from the alias owner.
    try {
      const { images, attachments: files } = media
      const selectedAudience = audienceRequest(
        audienceMode,
        creator.id,
        audienceMembers.map(member => member.id),
      )
      const request = {
        prompt: text,
        tier: qualityId,
        behavior,
        clientRequestId,
        ...(images.length === 0 ? {} : { images }),
        ...(files.length === 0 ? {} : { attachments: files }),
        ...(agentFirstMessage === undefined ? {} : { agentFirstMessage }),
        ...(kind !== 'chat' && selectedAudience !== undefined
          ? { audience: selectedAudience }
          : {}),
      }
      const created = await sendReplayingUnknownOutcome(
        () => creationMessage.mutateAsync(request),
        () => prompt.read().trim().length > 0 || attachments.drafting(),
      )
      if (!routeActive.current) return 'rejected' as const
      retryRequest.current = undefined
      attachments.commit()
      /* Before anything navigates. The response holds the conversation the next
         surface is about to ask for, and for a job that surface is a fresh
         mount keyed to an id it did not have a moment ago — so without this the
         reader watches a skeleton for one round trip after pressing Send. */
      if ('snapshot' in created) {
        seedCreatedSessionCache(queryClient, workspaceSlug, created.snapshot, created.history)
      }
      const createdSessionId = 'session' in created ? created.session.sessionId : created.sessionId
      /* Whatever was typed while the session was being minted is the
         conversation's next message, not this composer's: it crosses to the
         conversation by id, and this draft starts clean for the next start. */
      handOffComposerDraft(workspaceSlug, createdSessionId, prompt.read())
      prompt.reset()
      onCreated(createdSessionId)
      if (kind !== 'chat') {
        /* The accepted session is already in the point cache, so its canonical
           destination can paint immediately. Lists remain server-owned and
           reconcile in the background; a slow list refresh must not hold the
           reader on the creation surface after the create itself succeeded. */
        void refreshCreatedSessionCollections(queryClient, workspaceSlug).catch(noop)
      }
      /* The row this owner's pointer now names, recorded before anything is
         re-asked: the refetch below is a round trip, and the first frames of
         this conversation do not wait for it. See `stampDefaultChat`. */
      /* Work deliberately leaves the pointer untouched. A job that stamped
         it would become this owner's chat, which is the one thing every
         surface around it is built to keep apart. */
      if (kind === 'chat' && 'snapshot' in created) {
        stampDefaultChat(
          queryClient,
          workspaceSlug,
          agentSlug ?? ROOT_AGENT_SCOPE,
          created.snapshot,
        )
      }
      /* ---- and the pointer this just stamped has to be re-asked ----
         Every read that answers "which session is this owner's chat" answered
         it a moment ago as "none", and this request is what made that false.
         The alias in particular is not refetched by anything on this surface,
         so without this the client would go on believing this owner has no chat
         for the rest of the visit — and the jobs lists would believe it too,
         splicing each streamed frame of the new conversation into the very
         lists built to withhold it. */
      if (kind === 'chat') invalidateDefaultChatPointer(queryClient, workspaceSlug)
      return 'committed' as const
    } catch (error) {
      if (!routeActive.current) return 'rejected' as const
      setSubmission(undefined)
      setSubmissionCwd(undefined)
      setSubmissionMedia(undefined)
      setSubmissionAgentFirstMessage(undefined)
      prompt.restoreSubmission(text)
      if (isConfirmedSubmissionRejection(error)) attachments.rejectSubmission()
      else attachments.restoreSubmission()
      if (error instanceof DuetApiError && error.code === 'invalid_audience_member') {
        void queryClient.invalidateQueries({
          queryKey: duetQueryKeys.workspaces.members(workspaceSlug),
        })
      }
      // React Query owns the rendered mutation error state.
      return 'rejected' as const
    }
  }
  return {
    // The prompt rendered by the pending conversation while the id is in flight;
    // also the signal that keeps the conversation mounted during creation.
    pendingPrompt: submission,
    pendingQuality: quality,
    pendingCwd: submissionCwd,
    pendingMedia: submissionMedia,
    pendingAgentFirstMessage: submissionAgentFirstMessage,
    clearPending,
    quality,
    setQuality,
    prompt,
    attachments,
    audience:
      kind !== 'chat'
        ? {
            mode: audienceMode,
            members: audienceMembers,
            creator,
            setMode: setAudienceMode,
            toggleMember: (member: SelectedAudienceMember) => {
              if (member.id === creator.id) return
              setAudienceMembers(current =>
                current.some(selected => selected.id === member.id)
                  ? current.filter(selected => selected.id !== member.id)
                  : [...current, member],
              )
            },
            submitting: creationMessage.isPending,
          }
        : undefined,
    submit,
    clearCreateFailure: creationMessage.reset,
    /* How the last create failed, or undefined if it did not. `refusal` is set
       only when the rejection was one a person can act on; everything else
       stays anonymous, because "try again" is the whole of the advice. */
    createFailure: creationMessage.isError
      ? {
          refusal: spendRefusalOf(creationMessage.error),
          audienceChanged:
            creationMessage.error instanceof DuetApiError &&
            creationMessage.error.code === 'invalid_audience_member',
        }
      : undefined,
  }
}

/**
 * The composer's seat at the bottom of every conversation shell — empty,
 * pending, and live use the identical element so the compose → pending → live
 * progression reconciles in place. One owner for two invariants:
 *
 * The *gutter* is the host's — every mount is a panel inside something that
 * already frames it, and a margin around a margin is a wedge — but the
 * *measure* stays deliberate: the timeline is `max-w-4xl`, while the composer
 * steps down to `max-w-3xl`. That leaves the transcript room for long tool and
 * message output without making the shorter input line feel like a page-wide
 * form. In narrow panels and on phones the max never binds, so the composer
 * still uses every usable pixel the host gives it.
 *
 * The footer passes flex squeeze down (`min-h-0` end to end) so a short window
 * shrinks the draft instead of pushing the send row under the fold — and it
 * never takes more than half of the conversation it sits in unless an audience
 * picker is present. That picker has fixed, interactive rows above the draft;
 * on a short viewport the ordinary ceiling would hide Search and Send instead
 * of asking the draft to squeeze. The picker keeps its selected people in one
 * horizontal rail, so lifting the ceiling does not let selection count grow
 * the footer vertically without bound.
 *
 * That half is the whole of the sizing rule, and it is one rule rather than
 * two. The thread above is `flex-1` off a zero basis, so flexbox hands it only
 * what the composer did not ask for and shrinks it before the composer gives
 * up a pixel: measured, a sixty-line draft left the thread 34% of a 640px
 * window, 13% of a 560px one, and *nothing at all* at 500px — a compose bar
 * with no conversation over it. The squeeze the compose bar builds for itself
 * (`chromeMinHeight`, and the editor row as the one row that gives way) is
 * correct and never got asked, because it only engages once the thread has
 * already reached zero.
 *
 * A share rather than a pixel ceiling because the two ends of the range want
 * opposite things from a constant: the same 160px that starves a 500px panel
 * is a porthole on a 1440px one, where a long draft was shown eight lines at a
 * time under a thousand pixels of unused thread. Half of the host answers both
 * without a second number, and on any ordinary window it never binds at all —
 * a compose bar wants about a fifth of a laptop's column.
 *
 * **Unless the agent is asking something.** The half is a rule about the
 * reader's own draft — text they wrote and can scroll — and the compose bar
 * carries one thing that is not that: the tray a waiting turn puts above it,
 * with the question and its answers in it. Capping that is capping the only
 * thing on screen the reader is being asked to act on, and on a short window it
 * measurably did: the answers slid under the tray's own sticky header. A
 * question outranks the thread, because a thread is what you read and a
 * question is what stops it, so the ceiling lifts for exactly as long as one is
 * on screen. `:has()` rather than a prop: whether a turn is waiting is the
 * compose bar's business, and it already says so in the DOM. The selector asks
 * for the viewport's `role`, not for the tray element — the tray stays mounted
 * after a turn ends so it can animate out, and keying on its presence would
 * lift the ceiling permanently after the first reply.
 *
 * Lifting it puts the draft and the tray in competition, though, and the
 * compose bar settles that the wrong way round for this case: its own rule is
 * that the *tray* takes the squeeze so Send can never be pushed off (see
 * `compose-bar.tsx`), which is right when the tray is a status line and wrong
 * when it is holding the question. So the draft gets a ceiling of its own for
 * exactly as long as the tray is up. Ten lines is what the whole compose bar
 * used to be capped at, everywhere, for every host — this is that number
 * surviving in the one place it was ever doing work.
 */
function SessionComposerFooter({ children }: { children: ReactNode }) {
  return (
    <footer
      data-session-composer-footer
      className="relative z-10 flex min-h-0 flex-col bg-background px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 [&:has([data-compose-session-viewport][role='region'])_[data-compose-bar-editor]]:max-h-40 [&:not(:has([data-compose-session-viewport][role='region'])):not(:has([data-session-audience-picker]))]:max-h-[50%] [&:has([data-session-audience-picker])]:max-h-full"
    >
      <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-col [&:has(>[data-session-audience-picker])>[data-compose-bar-root]]:shrink-0 [&>[data-session-audience-picker]]:min-h-0 [&>[data-session-audience-picker]]:overflow-y-auto">
        {children}
      </div>
    </footer>
  )
}

function SessionCreationComposer({
  workspaceSlug,
  ownerAgentSlug,
  creation,
  cwd,
  duetName,
  agent,
  placeholder,
  autoFocus = true,
  creditRecovery,
  audiencePlacement = 'above',
  submitAccessory,
}: {
  workspaceSlug: string
  ownerAgentSlug: string
  creation: SessionCreationController
  cwd?: string
  duetName: string
  agent?: SessionAgentIdentity
  placeholder: string
  autoFocus?: boolean
  creditRecovery: WorkspaceCreditRecovery
  audiencePlacement?: 'above' | 'banner'
  submitAccessory?: ReactNode
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const qualityOptions = useSessionQualityOptions()
  const skills = useSessionSkills(workspaceSlug, cwd)
  const agentRoster = useSessionAgents(workspaceSlug, ownerAgentSlug)
  useClearSpendRefusalAfterRecovery(
    creation.createFailure?.refusal,
    creditRecovery,
    creation.clearCreateFailure,
  )
  const audiencePicker =
    creation.audience === undefined ? null : (
      <SessionAudiencePicker
        workspaceSlug={workspaceSlug}
        mode={creation.audience.mode}
        members={creation.audience.members}
        creator={creation.audience.creator}
        duetName={duetName}
        disabled={creation.audience.submitting}
        variant={audiencePlacement === 'banner' ? 'compact' : 'default'}
        onModeChange={creation.audience.setMode}
        onToggleMember={creation.audience.toggleMember}
      />
    )

  return (
    <>
      {audiencePlacement === 'above' ? audiencePicker : null}
      <SessionComposer
        mode="message"
        value={creation.prompt.value}
        onValueChange={creation.prompt.acceptEditorValue}
        onSubmit={payload => creation.submit(payload)}
        input={{
          label: t('describeTask', { name: agent?.name ?? duetName }),
          placeholder,
          autoFocus,
          variant: audiencePlacement === 'banner' ? 'prominent' : 'default',
          minHeight: audiencePlacement === 'banner' ? 60 : undefined,
        }}
        attachments={{
          items: creation.attachments.items,
          onFilesSelected: creation.attachments.add,
          onRemove: creation.attachments.remove,
          onRetry: attachment => creation.attachments.retry(attachment.id),
          retryLabel: t('retryUpload'),
          fileInput: { label: t('attachFiles') },
          dropLabel: t('dropFiles'),
          getRemoveLabel: attachment => t('removeAttachment', { name: attachment.name }),
        }}
        classNames={{
          surface: cn(
            'border-border/70 bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-brand/35 focus-within:ring-2 focus-within:ring-brand/10',
            audiencePlacement === 'banner' && 'rounded-xl',
          ),
        }}
        quality={{
          label: t('quality'),
          value: creation.quality,
          ...qualityOptions,
          onValueChange: creation.setQuality,
        }}
        skills={skills}
        agents={agentRoster}
        status={creation.createFailure?.refusal ? t('sendingPaused') : undefined}
        submitAccessory={submitAccessory}
        submit={{
          label: creation.createFailure?.refusal ? t('billingNeededToSend') : t('send'),
          submittingLabel: t('creating'),
          tooltip: t('startTooltip', { name: agent?.name ?? duetName }),
          disabledTooltip: creation.attachments.busy
            ? t('attachmentsBusyTooltip')
            : t('startDisabledTooltip', { name: agent?.name ?? duetName }),
          blockedTooltip: t('billingTooltip'),
          submittingTooltip: t('creatingTooltip'),
          blocked: creation.createFailure?.refusal !== undefined,
          enabled:
            draftCanSend(creation.prompt.value, creation.attachments) &&
            creation.createFailure?.refusal === undefined,
        }}
        banner={
          audiencePlacement === 'banner' || creation.createFailure ? (
            <div className="space-y-2">
              {audiencePlacement === 'banner' ? audiencePicker : null}
              {creation.createFailure ? (
                creation.createFailure.refusal ? (
                  <SpendRefusalNotice
                    refusal={creation.createFailure.refusal}
                    agentName={agent?.name ?? duetName}
                    onRecoveryStart={creation.clearCreateFailure}
                  />
                ) : (
                  <p role="alert" className="text-xs text-destructive">
                    {t(
                      creation.createFailure.audienceChanged
                        ? 'audience.changedError'
                        : 'createError',
                    )}
                  </p>
                )
              ) : null}
            </div>
          ) : undefined
        }
      />
    </>
  )
}

/**
 * Starts an ordinary top-level session without touching the selected owner's
 * default-chat pointer. Team Space calls these conversations; an agent owner
 * is attributed by its cwd, through the same ordinary create route as a job.
 */
export function useWorkSessionCreation({
  workspaceSlug,
  defaultTier,
  seed,
  ownerCwd,
  agentSlug = ROOT_AGENT_SCOPE,
  onStarted,
}: {
  workspaceSlug: string
  defaultTier: ModelSelectionId
  /** A starter the reader picked; a new object per pick, so picking it again re-applies it. */
  seed?: { text: string }
  ownerCwd?: string
  agentSlug?: string
  onStarted: (sessionId: string) => void
}) {
  const creation = useSessionCreation(
    workspaceSlug,
    defaultTier,
    ownerCwd,
    onStarted,
    agentSlug,
    undefined,
    'work',
  )
  // Applied once per pick, never on a later render: the draft is the reader's
  // the moment they type into it, including while the first message is sending.
  const resetDraft = useRef(creation.prompt.reset)
  resetDraft.current = creation.prompt.reset
  useEffect(() => {
    if (seed !== undefined) resetDraft.current(seed.text)
  }, [seed])

  return creation
}

export function WorkSessionStarter({
  workspaceSlug,
  ownerAgentSlug,
  duetName,
  creditRecovery,
  creation,
  placeholder,
  submitAccessory,
}: {
  workspaceSlug: string
  ownerAgentSlug: string
  duetName: string
  creditRecovery: WorkspaceCreditRecovery
  creation: WorkSessionCreationController
  placeholder: string
  submitAccessory?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <SessionCreationComposer
        workspaceSlug={workspaceSlug}
        ownerAgentSlug={ownerAgentSlug}
        creation={creation}
        duetName={duetName}
        placeholder={placeholder}
        creditRecovery={creditRecovery}
        audiencePlacement="banner"
        submitAccessory={submitAccessory}
      />
    </div>
  )
}

/**
 * A reactive recovery is only conclusive after this refusal has observed the
 * workspace in a recovery state. That distinction preserves the useful 402
 * when the workspace projection was stale and still said `null`, while letting
 * a top-up completed in another tab (or by the owner) unlock this mounted
 * composer as soon as the projection returns to normal.
 */
function useClearSpendRefusalAfterRecovery(
  refusal: SpendRefusal | undefined,
  creditRecovery: WorkspaceCreditRecovery,
  clear: () => void,
): void {
  const recoveryObserved = useRef(false)
  useEffect(() => {
    if (refusal === undefined) {
      recoveryObserved.current = false
      return
    }
    if (creditRecovery !== null) {
      recoveryObserved.current = true
      return
    }
    if (recoveryObserved.current) clear()
  }, [clear, creditRecovery, refusal])
}

/**
 * An owner's default chat before its first message: an empty conversation.
 *
 * This mirrors the conversation shell to the element — gradient, a header
 * slot, the timeline's scroller, a footer with the composer in the same
 * measure — so the compose → pending → live progression reconciles the same
 * structure in place rather than tearing a centred hero down around the
 * composer mid-submit. The composer is pinned at the bottom because that is
 * where it will spend the rest of the conversation's life.
 *
 * The thread itself carries first-contact content, in priority order: the
 * agent's suggested first message when it has one (rendered as the agent's
 * own bubble — the first send materializes exactly this text into history),
 * else the generic day-one intro — mascot and accent line, the same greeting
 * V1 puts at the top of an empty channel. Either way it is thread content,
 * not a hero: it sits inside the scroller the messages will fill, so the
 * first message replaces it without moving anything around the composer.
 */
function SessionEmptyChat({
  workspaceSlug,
  creation,
  cwd,
  ownerAgentSlug,
  duetName,
  agent,
  suggestedFirstMessage,
  placeholder,
  creditRecovery,
}: {
  workspaceSlug: string
  creation: SessionCreationController
  /** overrides the rotating greeting; the job composer asks for a task instead */
  placeholder?: string
  /** the owner this composer belongs to; `root` for the drive itself */
  ownerAgentSlug: string
  /** the owner's anchor folder; the root owner has none */
  cwd?: string
  duetName: string
  agent?: SessionAgentIdentity
  suggestedFirstMessage?: string
  creditRecovery: WorkspaceCreditRecovery
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const { api } = useSpa()
  /* The rotating greetings are a *chat's* — "Ask Duet anything" invites a
     conversation, and this composer starts work. A caller that knows better
     says so; the roll is the default, not the rule. */
  const rolledPlaceholder = useComposePlaceholder(agent?.name ?? duetName)
  const promptPlaceholder = placeholder ?? rolledPlaceholder
  // An agent-only timeline: no input rows exist yet, so an empty directory is
  // the honest one — nothing here resolves an author.
  const authors = useMemo(() => createSessionAuthorDirectory({ duetName }), [duetName])
  const suggestedMessages: ProjectedMessage[] | undefined =
    suggestedFirstMessage === undefined
      ? undefined
      : [agentFirstMessageProjection('suggested-first-message', suggestedFirstMessage)]
  return (
    <div
      data-session-conversation
      data-session-empty-chat
      className="relative flex h-full min-w-0 flex-1 flex-col bg-background"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-brand/[0.07] via-brand/[0.03] to-transparent"
      />
      {/* The header slot, empty: a chat that has not started has nothing to be
          titled by, and the slot keeps the scroller and footer in the child
          positions the pending shell puts them in. */}
      {null}
      {/* The agent's suggested first message renders as thread content in the
          agent's own voice — it is the message the first send will materialize,
          so it sits where that message will sit (D11); only an agent with
          nothing to say leaves the generic day-one intro. */}
      {suggestedMessages !== undefined ? (
        <VirtualizedSessionTimeline
          messages={suggestedMessages}
          timelineLabel={t('timeline')}
          loadingEarlierLabel={t('loadingEarlier')}
          loadEarlierFailedLabel={t('loadEarlierFailed')}
          retryEarlierLabel={t('retryEarlier')}
          hasOlder={false}
          isLoadingOlder={false}
          loadOlderFailed={false}
          className="[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
          duetName={duetName}
          agent={agent}
          workspaceSlug={workspaceSlug}
          authors={authors}
          imageUrl={() => 'about:blank'}
          cwd={cwd}
          fileUrl={drivePath => api.workspaceFileDownloadUrl(workspaceSlug, drivePath)}
        />
      ) : (
        <div
          role="log"
          aria-label={t('timeline')}
          aria-live="polite"
          className="relative min-h-0 flex-1 scroll-pb-16 overflow-y-auto scroll-smooth py-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
        >
          <div className="relative mx-auto h-full max-w-4xl">
            <div className="grid h-full place-items-center py-6">
              <SessionIntro />
            </div>
          </div>
        </div>
      )}
      <SessionComposerFooter>
        <SessionCreationComposer
          workspaceSlug={workspaceSlug}
          ownerAgentSlug={ownerAgentSlug}
          creation={creation}
          cwd={cwd}
          duetName={duetName}
          agent={agent}
          placeholder={promptPlaceholder}
          creditRecovery={creditRecovery}
        />
      </SessionComposerFooter>
    </div>
  )
}

/* Exported so the agent chat surface can host the real conversation in a
   column rather than reimplementing one. It is already column-safe: when the
   app pane opens it shrinks itself to `lg:w-[40%] lg:max-w-[520px]`, so a
   two-thirds parent is a width it has always supported. It needs a bounded
   height, like every `h-full` surface here. */
export function SessionConversation({
  workspaceSlug,
  agents,
  ownerAgentSlug,
  sessionId,
  pendingPrompt,
  pendingAgentFirstMessage,
  pendingQuality,
  defaultTier,
  duetName,
  pendingCwd,
  pendingMedia,
  pendingDraft,
  pane = false,
  creditRecovery,
  loadingFallback,
}: {
  workspaceSlug: string
  agents: readonly Agent[]
  /** the owner this composer belongs to; `root` for the drive itself */
  ownerAgentSlug: string
  sessionId: string | undefined
  pendingPrompt?: string
  pendingAgentFirstMessage?: string
  pendingQuality?: ModelSelectionId
  defaultTier: ModelSelectionId
  duetName: string
  pendingCwd?: string
  pendingMedia?: SessionAttachmentPayload
  /** the creation flow's draft, written into while the first message is minting the session */
  pendingDraft?: SessionDraftInput
  /** whether this host lets the session open its app beside itself — see SessionsProduct */
  pane?: boolean
  creditRecovery: WorkspaceCreditRecovery
  loadingFallback?: ReactNode
}) {
  const appT = useTranslations('duetApp')
  const t = useTranslations('duetApp.sessionProduct')
  const resolvedLoadingFallback = loadingFallback ?? (
    <SessionDetailSkeleton label={t('loadingSession')} />
  )
  const showToast = useToast()
  const qualityOptions = useSessionQualityOptions()
  const { api, clock } = useSpa()
  const notifyStorageFull = useStorageFullNotifier(workspaceSlug)
  const fileProvider = useMemo(
    () =>
      new RestFileSystemProvider(workspaceSlug, api, error =>
        notifyStorageFull({ kind: 'file', error }),
      ),
    [api, notifyStorageFull, workspaceSlug],
  )
  const detail = useSessionDetail(workspaceSlug, sessionId, event =>
    notifyStorageFull({ kind: 'session', event }),
  )
  const actions = useSessionActions(workspaceSlug, sessionId)
  const routeActive = useRouteLifetime()
  const retryRequest = useRef<
    | {
        mode: SessionComposerMode
        text: string
        tier?: ModelSelectionId
        behavior?: AgentPromptBehavior
        attachmentsKey: string
        id: string
      }
    | undefined
  >(undefined)
  const [composerMode, setComposerMode] = useState<SessionComposerMode>('message')
  const [quality, setQuality] = useState<ModelSelectionId>(defaultTier)
  const draft = useSubmissionDraft()
  const attachmentOptions = useSessionAttachmentOptions(workspaceSlug)
  const attachments = useSessionAttachments({
    workspaceSlug,
    scopeCwd: detail.snapshot.data?.cwd ?? pendingCwd,
    ...attachmentOptions,
  })
  /* How the last submission failed, or undefined if it did not. `refusal` is
     set only when the rejection was one a person can act on; everything else
     stays anonymous, because "try again" is the whole of the advice. */
  const [sendFailure, setSendFailure] = useState<{ refusal?: SpendRefusal }>()
  const clearSendFailure = useCallback(() => setSendFailure(undefined), [])
  useClearSpendRefusalAfterRecovery(sendFailure?.refusal, creditRecovery, clearSendFailure)
  const [interruptError, setInterruptError] = useState(false)
  const [todosExpanded, setTodosExpanded] = useState(true)
  const [tailRevision, setTailRevision] = useState(0)
  const snapshot = detail.snapshot.data
  // A session's cwd is the agent's, and the agent can move it mid-run, so the
  // skill picker follows the live snapshot rather than where the session started.
  // Before the session exists, the pending create's cwd is the only one there is.
  const skills = useSessionSkills(workspaceSlug, snapshot?.cwd ?? pendingCwd)
  // The roster is the owner's, not the session's cwd: an agent that moves its
  // working folder mid-run still answers to the same colleagues.
  const agentRoster = useSessionAgents(workspaceSlug, ownerAgentSlug)
  const paneApp = useSessionPaneApp(workspaceSlug, snapshot)
  const paneCwdKey = `${workspaceSlug}:${sessionId ?? ''}:${snapshot?.cwd ?? ''}`
  const [collapsedPaneKey, setCollapsedPaneKey] = useState<string>()
  const [mobilePaneOpen, setMobilePaneOpen] = useState(false)
  /* Only where the host allows it: the agent panel already shows this agent's
     apps beside the thread, and a second copy of one wedged into the thread's
     own column would say the same thing smaller. */
  const paneMounted = pane && paneApp !== undefined && collapsedPaneKey !== paneCwdKey
  const snapshotAgent = snapshot?.agent
  const sessionAgent = sessionAgentIdentity({
    snapshotAgent,
    pendingCwd,
    agents,
    workspaceSlug,
  })
  /* Who this conversation is with, by name: every line of the composer that
     addresses the agent says this, never a hard-coded "Duet". */
  const agentName = sessionAgent?.name ?? duetName
  const authors = useSessionAuthorDirectory(workspaceSlug, detail.projected?.messages)
  const viewerSender = useViewerInputSender()
  useOnboardingWatch(workspaceSlug, snapshot?.onboarding === true ? snapshotAgent?.id : undefined)

  // The panel is intentionally not keyed by session id (so it can persist across
  // the /new -> /:id navigation without remounting), so a session switch has to
  // clear the per-session composer state that a remount used to reset for free.
  useEffect(() => {
    setComposerMode('message')
    setQuality(defaultTier)
    setSendFailure(undefined)
    setInterruptError(false)
    setTodosExpanded(true)
    retryRequest.current = undefined
    attachments.discard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTier, sessionId, workspaceSlug])
  // Before paint, so a draft handed over from the creating composer never
  // shows as an empty editor for a frame on its way in.
  useLayoutEffect(() => {
    draft.reset(sessionId === undefined ? undefined : takeComposerDraft(workspaceSlug, sessionId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workspaceSlug])

  const sessionTier = snapshot?.tier
  useEffect(() => {
    if (sessionTier !== undefined) setQuality(sessionTier)
  }, [sessionTier])

  useEffect(() => {
    if (snapshot?.turnStatus !== 'ask') setComposerMode('message')
  }, [snapshot?.turnStatus])

  useEffect(() => {
    if (paneApp === undefined) setMobilePaneOpen(false)
  }, [paneApp])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeMobilePane = () => {
      if (desktop.matches) setMobilePaneOpen(false)
    }
    desktop.addEventListener('change', closeMobilePane)
    return () => desktop.removeEventListener('change', closeMobilePane)
  }, [])

  const loadEarlierMessages = async () => {
    try {
      await detail.loadOlder()
    } catch (error) {
      showToast({ message: t('loadEarlierFailed'), tone: 'error' })
      throw error
    }
  }

  const scheduledReminder = useScheduledReminderLabel(
    sessionAgent?.name ?? duetName,
    snapshot?.turnStatus === 'sleep' ? snapshot.machine?.nextWakeAt : undefined,
    t,
  )

  // Pending create: no real session yet. It draws the same conversation column
  // the loaded shell draws below — same element, same classes — so the id
  // handoff changes the content inside the surface rather than flashing a new
  // surface in. Keep the two in step.
  if (sessionId === undefined) {
    return (
      <LoadingHandoff loading={false} fallback={resolvedLoadingFallback} className="flex-1">
        <div
          data-session-conversation
          className="relative flex h-full min-w-0 flex-1 flex-col bg-background"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-brand/[0.07] via-brand/[0.03] to-transparent"
          />
          {/* No header: the panel has already named this surface, and a header
              that pops in for the seconds of the id handoff and back out again
              is chrome flashing, not information — the pending bubble already
              says "Sending…". */}
          <SessionFileViewerProvider
            workspaceSlug={workspaceSlug}
            api={api}
            provider={fileProvider}
          >
            <VirtualizedSessionTimeline
              messages={[
                // The agent's first message stays on screen through the id
                // handoff — the durable agent_message event replaces it in
                // place once the created session's history mounts.
                ...(pendingAgentFirstMessage === undefined
                  ? []
                  : [
                      agentFirstMessageProjection(
                        'pending-agent-first-message',
                        pendingAgentFirstMessage,
                      ),
                    ]),
                {
                  id: 'pending-create',
                  role: 'input' as const,
                  source: 'prompt' as const,
                  sender: viewerSender,
                  text: pendingPrompt ?? '',
                  ...(pendingMedia?.images.length ? { images: pendingMedia.images } : {}),
                  ...(pendingMedia?.attachments.length
                    ? { attachments: pendingMedia.attachments }
                    : {}),
                  pending: true,
                },
              ]}
              timelineLabel={t('timeline')}
              loadingEarlierLabel={t('loadingEarlier')}
              loadEarlierFailedLabel={t('loadEarlierFailed')}
              retryEarlierLabel={t('retryEarlier')}
              hasOlder={false}
              isLoadingOlder={false}
              loadOlderFailed={false}
              duetName={duetName}
              agent={sessionAgent}
              workspaceSlug={workspaceSlug}
              authors={authors}
              imageUrl={pendingImageUrl}
              cwd={sessionTimelineCwd({
                sessionId,
                persistedCwd: snapshot?.cwd,
                pendingCwd,
              })}
              fileUrl={drivePath => api.workspaceFileDownloadUrl(workspaceSlug, drivePath)}
            />
          </SessionFileViewerProvider>
          <SessionComposerFooter>
            {null}
            {/* Live while the session is minted: the reader keeps writing,
                and only Send waits for the conversation to have an address.
                The words cross to the opened conversation by id; files wait
                for its own composer, whose uploads belong to the session. */}
            <SessionComposer
              mode="message"
              skills={skills}
              agents={agentRoster}
              value={pendingDraft?.value ?? ''}
              onValueChange={pendingDraft?.acceptEditorValue ?? noop}
              onSubmit={rejectPendingSubmit}
              submitting
              input={{
                label: t('messageLabel', { name: agentName }),
                placeholder: t('messagePlaceholder'),
              }}
              classNames={{ surface: 'border-border/70 bg-card shadow-sm' }}
              quality={{
                label: t('quality'),
                value: pendingQuality ?? defaultTier,
                ...qualityOptions,
                onValueChange: noop,
                disabled: true,
              }}
              submit={{
                label: t('send'),
                submittingLabel: t('creating'),
                submittingTooltip: t('conversationStartingTooltip'),
              }}
            />
          </SessionComposerFooter>
        </div>
      </LoadingHandoff>
    )
  }

  const loading = sessionDetailIsLoading({
    snapshotPending: detail.snapshot.isPending,
    snapshotError: detail.snapshot.isError,
    historyPending: detail.history.isPending,
    historyError: detail.history.isError,
  })
  if (loading) {
    return (
      <LoadingHandoff loading fallback={resolvedLoadingFallback} className="flex-1">
        {null}
      </LoadingHandoff>
    )
  }
  if (snapshot === undefined || detail.projected === undefined)
    return (
      <DetailState
        title={t('unavailableTitle')}
        body={t('unavailableBody')}
        action={
          <button
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}
            onClick={() => {
              void Promise.all([detail.snapshot.refetch(), detail.history.refetch()])
            }}
          >
            {appT('retry')}
          </button>
        }
      />
    )

  const submit = async (submission: SessionComposerSubmitPayload<ModelSelectionId>) => {
    const text = submission.value.trim()
    if (!draftCanSend(text, attachments)) return 'rejected' as const
    const submittedMode = submission.mode
    const submittedTier =
      submittedMode === 'message' ? (submission.qualityId ?? quality) : undefined
    const behavior = submittedMode === 'message' ? submission.behavior : undefined
    const clientRequestId = reuseSessionClientRequestId(retryRequest.current, {
      mode: submittedMode,
      text,
      tier: submittedTier,
      behavior,
      attachmentsKey: attachments.key,
    })
    retryRequest.current = {
      mode: submittedMode,
      text,
      attachmentsKey: attachments.key,
      ...(submittedTier === undefined ? {} : { tier: submittedTier }),
      ...(behavior === undefined ? {} : { behavior }),
      id: clientRequestId,
    }
    const payload = takeSubmittedAttachments(attachments)
    if (payload === undefined) return 'rejected' as const
    setSendFailure(undefined)
    draft.beginSubmission()
    // Whether the failure was already reconciled as accepted; asking consumes the answer.
    let reconciled = false
    // The answer, once settled, hands the composer back to messages — unless
    // the reader already chose another mode while it was sending.
    const leaveAnswerMode = () =>
      setComposerMode(current => (current === 'answer' ? 'message' : current))
    try {
      const attachmentInput = {
        ...(payload.images.length === 0 ? {} : { images: payload.images }),
        ...(payload.attachments.length === 0 ? {} : { attachments: payload.attachments }),
      }
      const send = (): Promise<unknown> =>
        submission.mode === 'note'
          ? actions.note.mutateAsync({
              note: text,
              clientRequestId,
              ...attachmentInput,
            })
          : submission.mode === 'answer'
            ? actions.answer.mutateAsync({
                answer: text,
                clientRequestId,
                ...attachmentInput,
              })
            : actions.message.mutateAsync({
                prompt: text,
                tier: submission.qualityId ?? quality,
                behavior: submission.behavior,
                clientRequestId,
                ...attachmentInput,
              })
      const acceptance = sendReplayingUnknownOutcome(send, () => {
        if (actions.consumeReconciled(`input:${clientRequestId}`)) {
          reconciled = true
          return false
        }
        return draft.read().trim().length > 0 || attachments.drafting()
      })
      // Registering the mutation appends the optimistic row. Move to that row
      // now, not after the request resolves: a slow send must still feel sent.
      setTailRevision(revision => revision + 1)
      await acceptance
      if (submission.mode === 'answer') leaveAnswerMode()
      retryRequest.current = undefined
      attachments.commit()
      return 'committed' as const
    } catch (error) {
      if (!routeActive.current) return 'rejected' as const
      if (reconciled || actions.consumeReconciled(`input:${clientRequestId}`)) {
        retryRequest.current = undefined
        attachments.commit()
        if (submittedMode === 'answer') leaveAnswerMode()
        setTailRevision(revision => revision + 1)
        return 'committed' as const
      }
      draft.restoreSubmission(text)
      if (isConfirmedSubmissionRejection(error)) attachments.rejectSubmission()
      else attachments.restoreSubmission()
      // The failed words return in the mode they were sent in, so a note can
      // never come back as a message that wakes the agent.
      setComposerMode(submittedMode)
      setSendFailure({ refusal: spendRefusalOf(error) })
      return 'rejected' as const
    }
  }
  const initialDeliveryPending = snapshot.deliveryAttempt !== undefined
  const pending = actions.message.isPending || actions.note.isPending || actions.answer.isPending
  const currentQuestion = latestSessionQuestion(detail.projected.messages)
  const showQuestionPanel =
    snapshot.turnStatus === 'ask' &&
    currentQuestion !== undefined &&
    supportsQuestionOptionPanel(currentQuestion.questions)
  const composeSessionBase = composeSessionFromApi({
    sessionId,
    turnStatus: snapshot.turnStatus,
    sending: pending,
    todos: detail.projected.todos,
    questions: currentQuestion?.questions,
    sleepingHint: scheduledReminder.hint,
    labels: {
      working: t('workingStatus', { name: agentName }),
      needsInput: t('needsInput', { name: agentName }),
      sleeping: scheduledReminder.primary,
      todos: t('todos'),
      expandTodos: t('expandTodos'),
      collapseTodos: t('collapseTodos'),
      todoPending: t('todoPending'),
      todoActive: t('todoActive'),
      todoComplete: t('todoComplete'),
      todoFailed: t('todoFailed'),
    },
    avatar: (
      <AgentAvatar
        avatarKey={sessionAgent?.avatarKey ?? duetName}
        duet={sessionAgent === undefined}
        profile={sessionAgent?.profile}
        workspaceSlug={workspaceSlug}
        className="size-6 ring-1 ring-border/70"
      />
    ),
    tones: SESSION_STATUS_TONES,
    todosExpanded,
    onTodosExpandedChange: setTodosExpanded,
    action:
      snapshot.turnStatus === 'running' || snapshot.turnStatus === 'sleep'
        ? {
            label: t(snapshot.turnStatus === 'sleep' ? 'stop' : 'interrupt'),
            pendingLabel: t(snapshot.turnStatus === 'sleep' ? 'stopping' : 'interrupting'),
            ...(snapshot.turnStatus === 'sleep'
              ? {
                  ariaLabel: t('stopSession'),
                  title: t('stopSession'),
                }
              : {}),
            pending: actions.interrupt.isPending,
            error: interruptError ? t('actionError') : undefined,
            onSelect: () => {
              setInterruptError(false)
              void actions.interrupt.mutateAsync().catch(() => {
                if (!routeActive.current || actions.consumeReconciled('interrupt')) return
                setInterruptError(true)
              })
            },
          }
        : undefined,
  })
  const composeSession =
    showQuestionPanel && currentQuestion && composeSessionBase
      ? {
          ...composeSessionBase,
          questions: {
            key: `${sessionId}:${currentQuestion.id}`,
            items: currentQuestion.questions,
            labels: {
              question: t('questionLabel'),
              fallback: (index: number) => t('questionFallback', { index }),
              pending: t('questionPending'),
              pendingWithCount: (index: number, count: number) =>
                t('questionPendingWithCount', { index, count }),
              collapse: t('collapseQuestion'),
              expand: t('expandQuestion'),
              previous: t('previousQuestion'),
              next: t('nextQuestion'),
              submit: t('submitAnswers'),
              doneNext: t('doneNext'),
              doneSubmit: t('doneSubmit'),
              submitError: t('answerSubmitError'),
            },
            submitting: actions.answer.isPending,
            onSubmit: async (selections: readonly ComposeBarSessionQuestionSelection[]) => {
              const answer = serializeSessionQuestionAnswers(currentQuestion.questions, selections)
              if (!answer) return

              const clientRequestId = crypto.randomUUID()
              const acceptance = actions.answer.mutateAsync({ answer, clientRequestId })
              setTailRevision(revision => revision + 1)
              await acceptance.catch(error => {
                if (actions.consumeReconciled(`input:${clientRequestId}`)) return
                throw error
              })
              setComposerMode('message')
            },
          },
        }
      : composeSessionBase

  /* Declared once because both header shapes below mount it — see the note
     where `bare` chooses between them. */
  const relay =
    snapshot.machine === undefined ? null : (
      <RelayStatus
        summary={snapshot.machine}
        stateMachine={detail.projected.stateMachine}
        className="flex min-w-10 max-w-[30rem] flex-[0_1_30rem] justify-end xl:max-w-[34rem] xl:flex-[0_1_34rem]"
      />
    )

  return (
    <LoadingHandoff loading={false} fallback={resolvedLoadingFallback} className="flex-1">
      <div className="flex h-full min-h-0 min-w-0">
        <div
          data-session-conversation
          className={cn(
            'relative flex h-full min-w-0 flex-1 flex-col bg-background',
            paneMounted && 'lg:w-[40%] lg:min-w-[380px] lg:max-w-[520px] lg:flex-none lg:border-r',
          )}
        >
          {/* The light starts behind the header and washes down into the
          conversation; the header's translucent blur lets it glow through. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-brand/[0.07] via-brand/[0.03] to-transparent"
          />
          {/* The host has already named this surface, so the title, the back
              door and the actions menu are its to draw — but live state is not a
              second heading. Which
              step a sleeping session is parked on is the reason its job is
              worth opening, which conversation minted this one is a fact the
              host's own row never carried, and the app pane's controls belong
              beside the pane they govern — so those come through on this one
              strip, and the strip exists only while it has something to say. */}
          {relay === null &&
          snapshot.createdBySessionId === undefined &&
          !(pane && paneApp !== undefined) ? null : (
            <header className="relative flex min-h-11 items-center gap-3 border-b border-border/40 bg-background/70 px-3 backdrop-blur-md md:px-5">
              <div className="flex min-w-0 flex-1 items-center">
                {snapshot.createdBySessionId !== undefined ? (
                  <SessionLineageChip
                    workspaceSlug={workspaceSlug}
                    parentId={snapshot.createdBySessionId}
                  />
                ) : null}
              </div>
              {relay}
              {pane && paneApp !== undefined && !paneMounted ? (
                <button
                  type="button"
                  aria-label={t('expandAppPane', {
                    name: appDisplayName(paneApp),
                  })}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'hidden size-8 shrink-0 lg:inline-flex',
                  )}
                  onClick={() => setCollapsedPaneKey(undefined)}
                >
                  <SidebarSimple />
                </button>
              ) : null}
              {pane && paneApp !== undefined ? (
                <Dialog open={mobilePaneOpen} onOpenChange={setMobilePaneOpen}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('openAppPane', {
                        name: appDisplayName(paneApp),
                      })}
                      className="inline-flex h-8 max-w-36 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 text-xs font-medium shadow-sm lg:hidden"
                    >
                      <AppIcon
                        app={paneApp}
                        status={appDisplayStatus(paneApp)}
                        workspaceSlug={workspaceSlug}
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">{appDisplayName(paneApp)}</span>
                    </button>
                  </DialogTrigger>
                  <DialogContent
                    hideCloseButton
                    data-session-app-viewer
                    className="inset-0 left-0 top-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none lg:hidden"
                  >
                    <DialogTitle className="sr-only">
                      {t('appPaneTitle', { name: appDisplayName(paneApp) })}
                    </DialogTitle>
                    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
                      <DialogClose asChild>
                        <button
                          type="button"
                          data-app-viewer-close
                          aria-label={t('closeAppPane')}
                          className={cn(
                            buttonVariants({ variant: 'ghost', size: 'icon' }),
                            'size-8',
                          )}
                        >
                          <ArrowLeft />
                        </button>
                      </DialogClose>
                      <AppIcon
                        app={paneApp}
                        status={appDisplayStatus(paneApp)}
                        workspaceSlug={workspaceSlug}
                        className="size-5"
                      />
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        {appDisplayName(paneApp)}
                      </p>
                    </header>
                    <AppFrameBody app={paneApp} workspaceSlug={workspaceSlug} />
                  </DialogContent>
                </Dialog>
              ) : null}
              <SessionStateInspector state={detail.projected.state} />
            </header>
          )}
          <SessionFileViewerProvider
            workspaceSlug={workspaceSlug}
            api={api}
            provider={fileProvider}
          >
            <VirtualizedSessionTimeline
              key={`${workspaceSlug}:${sessionId}`}
              messages={detail.projected.messages}
              timelineLabel={t('timeline')}
              loadingEarlierLabel={t('loadingEarlier')}
              loadEarlierFailedLabel={t('loadEarlierFailed')}
              retryEarlierLabel={t('retryEarlier')}
              hasOlder={detail.hasOlder}
              isLoadingOlder={detail.isLoadingOlder}
              loadOlderFailed={detail.loadOlderFailed}
              loadOlder={loadEarlierMessages}
              tailRevision={tailRevision}
              emptyState={
                snapshot.turnStatus === 'running' ? (
                  <div
                    data-session-starting
                    role="status"
                    className="flex min-h-52 items-center justify-center gap-2 text-[13px] font-medium text-muted-foreground"
                  >
                    <CircleNotch className="size-4 motion-safe:animate-spin" aria-hidden />
                    <span>{t('starting')}</span>
                  </div>
                ) : undefined
              }
              duetName={duetName}
              agent={sessionAgent}
              workspaceSlug={workspaceSlug}
              running={snapshot.turnStatus === 'running'}
              clockNow={clock?.()}
              authors={authors}
              imageUrl={storageId => api.sessionImageUrl(workspaceSlug, sessionId, storageId)}
              cwd={sessionTimelineCwd({
                sessionId,
                persistedCwd: snapshot.cwd,
                pendingCwd,
              })}
              fileUrl={drivePath => api.workspaceFileDownloadUrl(workspaceSlug, drivePath)}
            />
          </SessionFileViewerProvider>
          <SessionComposerFooter>
            {snapshot.turnStatus === 'ask' && !showQuestionPanel ? (
              <div className="px-1 pb-1.5">
                <button
                  aria-pressed={composerMode === 'answer'}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'xs' }),
                    composerMode === 'answer'
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground',
                  )}
                  onClick={() =>
                    setComposerMode(current => (current === 'answer' ? 'message' : 'answer'))
                  }
                >
                  {t('answer')}
                </button>
              </div>
            ) : null}
            <SessionComposer
              mode={composerMode}
              value={draft.value}
              onValueChange={draft.acceptEditorValue}
              session={composeSession}
              skills={skills}
              agents={agentRoster}
              onSubmit={submit}
              input={{
                label: t(
                  composerMode === 'note'
                    ? 'noteLabel'
                    : composerMode === 'answer'
                      ? 'answerLabel'
                      : 'messageLabel',
                  { name: agentName },
                ),
                placeholder: t(
                  composerMode === 'note'
                    ? 'notePlaceholder'
                    : composerMode === 'answer'
                      ? 'answerPlaceholder'
                      : 'messagePlaceholder',
                  { name: agentName },
                ),
              }}
              submitting={pending}
              status={
                sendFailure?.refusal
                  ? t('sendingPaused')
                  : initialDeliveryPending
                    ? t('sending')
                    : undefined
              }
              attachments={{
                items: attachments.items,
                onFilesSelected: attachments.add,
                onRemove: attachments.remove,
                onRetry: attachment => attachments.retry(attachment.id),
                retryLabel: t('retryUpload'),
                fileInput: { label: t('attachFiles') },
                dropLabel: t('dropFiles'),
                getRemoveLabel: attachment => t('removeAttachment', { name: attachment.name }),
              }}
              classNames={{
                surface:
                  'border-border/70 bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-brand/35 focus-within:ring-2 focus-within:ring-brand/10',
              }}
              quality={
                composerMode === 'message'
                  ? {
                      label: t('quality'),
                      value: quality,
                      ...qualityOptions,
                      onValueChange: setQuality,
                    }
                  : undefined
              }
              aiToggle={
                composerMode === 'answer'
                  ? undefined
                  : {
                      label: t('askDuet', { name: agentName }),
                      enabled: composerMode === 'message',
                      onEnabledChange: enabled => setComposerMode(enabled ? 'message' : 'note'),
                      icon: (
                        <Image
                          unoptimized
                          src="/icons/duet-avatar.png"
                          alt=""
                          width={24}
                          height={24}
                          className="size-6 select-none object-cover"
                        />
                      ),
                    }
              }
              submit={{
                label: sendFailure?.refusal ? t('billingNeededToSend') : t('send'),
                submittingLabel: t('sending'),
                tooltip: t(
                  composerMode === 'note'
                    ? 'noteTooltip'
                    : composerMode === 'answer'
                      ? 'answerTooltip'
                      : 'messageTooltip',
                  { name: agentName },
                ),
                disabledTooltip: attachments.busy
                  ? t('attachmentsBusyTooltip')
                  : t(
                      composerMode === 'note'
                        ? 'noteDisabledTooltip'
                        : composerMode === 'answer'
                          ? 'answerDisabledTooltip'
                          : 'messageDisabledTooltip',
                    ),
                blockedTooltip: t('billingTooltip'),
                submittingTooltip: t('sendingTooltip'),
                blocked: sendFailure?.refusal !== undefined,
                enabled:
                  draftCanSend(draft.value, attachments) && sendFailure?.refusal === undefined,
              }}
              banner={
                sendFailure === undefined ? undefined : sendFailure.refusal ? (
                  <SpendRefusalNotice
                    refusal={sendFailure.refusal}
                    agentName={sessionAgent?.name ?? duetName}
                    onRecoveryStart={clearSendFailure}
                  />
                ) : (
                  <p role="alert" className="text-xs text-destructive">
                    {t('actionError')}
                  </p>
                )
              }
            />
          </SessionComposerFooter>
        </div>
        {paneMounted ? (
          <aside
            aria-label={`${appDisplayName(paneApp)} app`}
            data-session-app-pane
            className="hidden min-w-0 flex-1 flex-col bg-background lg:flex"
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
              <AppIcon
                app={paneApp}
                status={appDisplayStatus(paneApp)}
                workspaceSlug={workspaceSlug}
                className="size-5"
              />
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {appDisplayName(paneApp)}
              </p>
              <button
                type="button"
                aria-label={t('collapseAppPane')}
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-8')}
                onClick={() => setCollapsedPaneKey(paneCwdKey)}
              >
                <SidebarSimple />
              </button>
            </header>
            <AppFrameBody app={paneApp} workspaceSlug={workspaceSlug} />
          </aside>
        ) : null}
      </div>
    </LoadingHandoff>
  )
}

export function SessionStateInspector({ state }: { state: unknown }) {
  const t = useTranslations('duetApp.sessionProduct')
  // The raw state dump is a debugging aid; only local dev builds offer it.
  if (state === undefined || !isLocalSessionDebugHost(globalThis.location?.hostname)) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={t('state')}
          title={t('state')}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'size-8 text-muted-foreground',
          )}
        >
          <BracketsCurly size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 py-2">
          <p className="text-sm font-medium text-foreground">{t('state')}</p>
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {t('stateLocalOnly')}
          </p>
        </div>
        <div className="max-h-80 overflow-y-auto px-3 py-2.5">
          <PrettyObject data={state} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DetailState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center p-8 text-center">
      <h2 className="font-serif text-lg font-normal italic tracking-tight">{title}</h2>
      {body ? <p className="mt-2 max-w-sm text-sm text-muted-foreground">{body}</p> : null}
      {action}
    </div>
  )
}

function latestSessionQuestion(
  messages: readonly ProjectedMessage[],
): { id: string; questions: AgentTurnQuestion[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'agent') continue
    for (let part = message.parts.length - 1; part >= 0; part -= 1) {
      const candidate = message.parts[part]
      if (candidate?.kind === 'ask') return candidate
    }
  }
  return undefined
}
