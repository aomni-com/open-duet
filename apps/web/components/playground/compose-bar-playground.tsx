'use client'

import { BrainIcon, GlobeIcon } from '@phosphor-icons/react'
import { useState } from 'react'

import {
  ComposeBar,
  type ComposeBarAttachment,
  type ComposeBarSession,
  type ComposeBarSubmitPayload,
} from '@repo/ui/components/compose-bar'
import { ComposeBarMentionPicker } from '@repo/ui/components/compose-bar/compose-bar-mention-picker'

import appEn from '../../messages/en/app.json'
import { AgentAvatar } from '../../spa/agents/agent-avatar'
import {
  buildTierQualityOptions,
  buildAdvancedQualityOptions,
} from '../../spa/model-tiers/tier-quality-options'

const qualityOptions = buildTierQualityOptions()

const reasoningLevels = [
  { id: 'quick', label: 'Quick' },
  { id: 'thoughtful', label: 'Thoughtful' },
  { id: 'extended', label: 'Extended' },
] as const

// The session status pill's subject. A fixture value: the bar itself has no
// notion of agents — the session config carries whatever identity the host
// resolved.
const activeAgent = { id: 'duet', label: 'Duet' }

type QualityId = import('@repo/contract').ModelSelectionId
type ReasoningId = (typeof reasoningLevels)[number]['id']
type SessionActionState = 'idle' | 'pending' | 'error' | 'disabled'

/* Three scopes and one description long enough to clamp, so the picker's
   truncation and its two-line description both get looked at. */
const skills = [
  {
    id: '/home/duet/drive/.agents/skills/review',
    name: 'review',
    description: 'Closeout pass on a finished change — shape, diff, then docs.',
    path: '/home/duet/drive/.agents/skills/review',
    scopeLabel: 'Drive',
  },
  {
    id: '/home/duet/.duet/skills/write-spec',
    name: 'write-spec',
    description:
      'Break large features into independently verifiable, human-reviewable slices, with browser checkpoints and screenshot gates at every step.',
    path: '/home/duet/.duet/skills/write-spec',
    scopeLabel: 'Global',
  },
  {
    id: '/opt/duet/skills/relay',
    name: 'relay',
    path: '/opt/duet/skills/relay',
    scopeLabel: 'Built in',
  },
] as const

/* The picker draws whatever selection it is handed; the editor's suggestion
   plugin owns that index in production. A fixed one is what makes the popup
   reviewable without focusing the editor and inviting a blinking caret into
   the baseline. */
/* The product's own strings, not a copy of them: a baseline that asserts
   hand-written lookalikes verifies text no user will ever read, and the two
   drifted apart exactly that way ("No skills installed" here vs the shipped
   "No matching skills"). */
const SKILL_LABELS = {
  list: appEn.duetApp.sessionProduct.skills,
  loading: appEn.duetApp.sessionProduct.skillsLoading,
  empty: appEn.duetApp.sessionProduct.skillsEmpty,
  unavailable: appEn.duetApp.sessionProduct.skillsUnavailable,
}

const SKILL_CONTINUATION_LABELS = {
  loadMore: appEn.duetApp.sessionProduct.skillsLoadMore,
  loading: appEn.duetApp.sessionProduct.skillsLoadingMore,
  retry: appEn.duetApp.sessionProduct.skillsLoadMoreRetry,
}

const skillSuggestion = {
  trigger: 'skillMention',
  char: '/',
  query: 'r',
  items: skills,
  activeIndex: 0,
  select: () => {},
}

/* A draft that already contains a picked skill. The value is Markdown, so this
   is the round trip under test: the tag the agent parses must come back into
   the editor as the chip it was composed from. Loaded on demand rather than at
   mount, so the fixture's other scenarios still start from an empty composer. */
const EMPTY_SUGGESTION = {
  trigger: 'skillMention',
  char: '/',
  query: 'zzz',
  items: [],
  activeIndex: null,
  select: () => {},
}

/* The roster as a session actually receives it: the parent above, children
   below, one child still awaiting onboarding, and two colleagues answering to
   the same name — which is why every row shows its slug. */
/* Every relationship appears once, because every row carries a badge now and a
   relationship missing here is a badge the visual gate never renders. Order is
   the gateway's: self, parent, siblings, children.

   Row COUNT is load-bearing and this list is at its ceiling. The picker's own
   `max-h-64` scrolls past five rows, so a sixth pushes the two colleagues who
   share the name "Scout" out of frame — and that pair is the only visual proof
   that the slug on the second line is what tells them apart. The locked row is
   therefore the sibling rather than a fourth colleague; the none-eligible scene
   below covers a locked child. Nothing else here may be locked: the behavior
   spec types its way to `scout-web` and presses Enter. */
const agents = [
  {
    id: 'atlas',
    name: 'Atlas',
    slug: 'atlas',
    path: 'agents/research',
    description: 'atlas',
    scopeLabel: 'You',
  },
  { id: 'root', name: 'Duet', slug: 'root', description: 'root', scopeLabel: 'Parent' },
  {
    id: 'cartographer',
    name: 'Cartographer',
    slug: 'cartographer',
    path: 'agents/cartographer',
    description: 'cartographer',
    scopeLabel: 'Sibling',
    disabled: true,
    disabledLabel: 'Awaiting setup',
  },
  {
    id: 'scout',
    name: 'Scout',
    slug: 'scout',
    path: 'agents/research/scout',
    description: 'scout',
    scopeLabel: 'Child',
  },
  {
    id: 'scout-web',
    name: 'Scout',
    slug: 'scout-web',
    path: 'agents/research/scout-web',
    description: 'scout-web',
    scopeLabel: 'Child',
  },
] as const

const AGENT_LABELS = {
  list: appEn.duetApp.sessionProduct.agents,
  loading: appEn.duetApp.sessionProduct.agentsLoading,
  empty: appEn.duetApp.sessionProduct.agentsEmpty,
  unavailable: appEn.duetApp.sessionProduct.agentsUnavailable,
}

/* A row that is listed but cannot be picked, and a list where none can. Both
   are states the keyboard has to survive: the arrows step over the locked row,
   and an all-locked list has no active row at all — which is why `activeIndex`
   is nullable rather than defaulting to the first row and lying about what
   Enter would do. */
const agentSuggestion = {
  trigger: 'agentMention',
  char: '@',
  query: '',
  items: agents,
  activeIndex: 3,
  select: () => {},
}

const NONE_ELIGIBLE_SUGGESTION = {
  trigger: 'agentMention',
  char: '@',
  query: '',
  items: [
    {
      id: 'cartographer',
      name: 'Cartographer',
      description: 'cartographer',
      scopeLabel: 'Sibling',
      disabled: true,
      disabledLabel: 'Awaiting setup',
    },
    {
      id: 'draftsman',
      name: 'Draftsman',
      description: 'draftsman',
      scopeLabel: 'Child',
      disabled: true,
      disabledLabel: 'Awaiting setup',
    },
  ],
  activeIndex: null,
  select: () => {},
}

const AGENT_DRAFT =
  '<Agent name="Scout" slug="scout" path="agents/research/scout" /> should take the pricing pages'

const SKILL_DRAFT =
  '<Skill name="review" path="/home/duet/drive/.agents/skills/review" /> before the release goes out'

const readyAttachment: ComposeBarAttachment = {
  id: 'brief',
  name: 'launch-brief.pdf',
  meta: '842 KB',
  status: { label: 'Ready', display: 'badge' },
}

const fixtureAttachments = {
  uploading: [
    {
      id: 'uploading',
      name: 'research-notes.csv',
      meta: '1.4 MB',
      status: { label: 'Uploading · 42%' },
    },
  ],
  /* The widest refusal the product can actually produce, rather than the
     shortest — the chip has about four words before it truncates, and the
     size limit is the one reason that spends them on a number. Judging the
     layout against "Upload failed" would pass a row that clips in the field. */
  failed: [
    {
      id: 'failed',
      name: 'brand-guide.pdf',
      meta: '5.8 MB',
      status: { label: 'Over 32.0 GB', tone: 'danger' as const },
    },
  ],
  ready: [readyAttachment],
  mixed: [
    { id: 'image', name: 'wordmark.png', meta: '620 KB' },
    readyAttachment,
    { id: 'text', name: 'voice-and-tone.txt', meta: '12 KB' },
  ],
  ten: Array.from({ length: 10 }, (_, index) => ({
    id: `attachment-${index + 1}`,
    name: `reference-${String(index + 1).padStart(2, '0')}.${index % 3 === 0 ? 'pdf' : index % 3 === 1 ? 'csv' : 'txt'}`,
    meta: `${index + 2}00 KB`,
  })),
} satisfies Record<string, ComposeBarAttachment[]>

/* The picker anchors above a compose surface. These previews have no real one,
   so this names the gap instead of leaving three empty dashed boxes that read
   as broken UI. */
function ComposerStandIn() {
  return (
    <div className="flex h-10 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
      the composer this anchors above
    </div>
  )
}

export function ComposeBarPlayground() {
  const [value, setValue] = useState('')
  const [qualityId, setQualityId] = useState<QualityId>('balanced')
  const [reasoningId, setReasoningId] = useState<ReasoningId>('thoughtful')
  const [attachments, setAttachments] = useState<ComposeBarAttachment[]>([])
  const [lastSubmit, setLastSubmit] = useState<ComposeBarSubmitPayload<
    QualityId,
    ReasoningId
  > | null>(null)
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const [todosExpanded, setTodosExpanded] = useState(true)
  const [sessionAction, setSessionAction] = useState('No session action')
  const [sessionActionState, setSessionActionState] = useState<SessionActionState>('idle')
  const [sessionPhase, setSessionPhase] = useState<ComposeBarSession['phase']>('working')
  const [sessionHidden, setSessionHidden] = useState(false)
  const [skillsPreview, setSkillsPreview] = useState(false)
  const [agentsPreview, setAgentsPreview] = useState(false)
  /* A workspace that has registered nobody yet: the trigger still opens and
     says so, and Enter still sends, because a picker with nothing to insert
     must not hold the key. */
  const [agentsEmpty, setAgentsEmpty] = useState(false)

  const session: ComposeBarSession =
    sessionPhase === 'working'
      ? {
          key: 'playground-session:running',
          phase: 'working',
          label: `${activeAgent.label} is working`,
          avatar: (
            <AgentAvatar
              avatarKey={activeAgent.id}
              duet={activeAgent.id === 'duet'}
              className="size-6 ring-1 ring-border/70"
            />
          ),
          todos: {
            label: 'Session tasks',
            items: [
              { id: 'inspect', label: 'Inspect launch notes', status: 'complete' },
              { id: 'prepare', label: 'Prepare the handoff', status: 'active' },
              { id: 'verify', label: 'Verify staging', status: 'pending' },
            ],
            statusLabels: {
              pending: 'Pending',
              active: 'In progress',
              complete: 'Complete',
              failed: 'Failed',
            },
            expanded: todosExpanded,
            expandLabel: 'Expand session tasks',
            collapseLabel: 'Collapse session tasks',
            onExpandedChange: setTodosExpanded,
          },
          action: {
            label: 'Interrupt',
            pendingLabel: 'Interrupting',
            pending: sessionActionState === 'pending',
            disabled: sessionActionState === 'disabled',
            error:
              sessionActionState === 'error' ? 'The session could not be interrupted.' : undefined,
            onSelect: () => setSessionAction('Interrupt requested'),
          },
        }
      : sessionPhase === 'waiting'
        ? {
            key: 'playground-session:ask',
            phase: 'waiting',
            label: 'Duet needs your input',
            tone: 'text-amber-500',
            question: 'Who should own the production rollout?',
          }
        : {
            key: 'playground-session:sleep',
            phase: 'sleeping',
            label: 'Duet has a reminder set for an upcoming scheduled task.',
            tone: 'text-violet-500',
            hint: 'Chat with Duet anytime in the meantime.',
            action: {
              label: 'Stop',
              pendingLabel: 'Stopping',
              ariaLabel: 'Stop session',
              title: 'Stop session',
              pending: sessionActionState === 'pending',
              disabled: sessionActionState === 'disabled',
              error:
                sessionActionState === 'error'
                  ? 'The session could not be interrupted.'
                  : undefined,
              onSelect: () => setSessionAction('Interrupt requested'),
            },
          }

  return (
    <main className="min-h-screen bg-muted/20 px-4 py-16 text-foreground sm:px-8">
      <section className="mx-auto flex min-h-[38rem] w-full max-w-4xl flex-col justify-end rounded-3xl border bg-background/80 p-4 shadow-sm sm:p-8">
        <button className="sr-only" type="button" onClick={() => setDisabled(true)}>
          Disable compose bar
        </button>
        <button
          className="sr-only"
          type="button"
          onClick={() => {
            setSessionHidden(false)
            setSessionPhase('working')
          }}
        >
          Show working session
        </button>
        <button className="sr-only" type="button" onClick={() => setSessionHidden(true)}>
          Hide session
        </button>
        <button
          className="sr-only"
          type="button"
          onClick={() => {
            // Mirrors a live SSE flicker: a turn completes (session leaves the
            // composer) and the next turn starts before the exit settles.
            setSessionHidden(true)
            window.setTimeout(() => setSessionHidden(false), 60)
          }}
        >
          Replay session handoff
        </button>
        <button
          className="sr-only"
          type="button"
          onClick={() => {
            setSessionHidden(false)
            setSessionPhase('waiting')
          }}
        >
          Show waiting session
        </button>
        <button
          className="sr-only"
          type="button"
          onClick={() => {
            setSessionHidden(false)
            setSessionPhase('sleeping')
          }}
        >
          Show sleeping session
        </button>
        <button className="sr-only" type="button" onClick={() => setValue(SKILL_DRAFT)}>
          Load skill draft
        </button>
        <button className="sr-only" type="button" onClick={() => setSkillsPreview(true)}>
          Show skill picker
        </button>
        <button className="sr-only" type="button" onClick={() => setSkillsPreview(false)}>
          Hide skill picker
        </button>
        <button className="sr-only" type="button" onClick={() => setValue(AGENT_DRAFT)}>
          Load agent draft
        </button>
        <button className="sr-only" type="button" onClick={() => setAgentsPreview(true)}>
          Show agent picker
        </button>
        <button className="sr-only" type="button" onClick={() => setAgentsPreview(false)}>
          Hide agent picker
        </button>
        <button className="sr-only" type="button" onClick={() => setAgentsEmpty(true)}>
          Empty the agent roster
        </button>
        <button className="sr-only" type="button" onClick={() => setSessionActionState('pending')}>
          Show pending session action
        </button>
        <button className="sr-only" type="button" onClick={() => setSessionActionState('error')}>
          Show failed session action
        </button>
        <button className="sr-only" type="button" onClick={() => setSessionActionState('disabled')}>
          Disable session action
        </button>
        {Object.entries(fixtureAttachments).map(([state, items]) => (
          <button
            key={state}
            className="sr-only"
            type="button"
            onClick={() => setAttachments(items)}
          >
            Show {state} attachments
          </button>
        ))}
        <div className="mb-auto space-y-2 px-1 pt-2">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">UI primitive</p>
          <h1 className="text-2xl font-semibold tracking-tight">What can I do for you?</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            The fixture owns every value and side effect. The compose bar only renders them.
          </p>
        </div>

        <ComposeBar
          value={value}
          disabled={disabled}
          onValueChange={setValue}
          session={sessionHidden ? undefined : session}
          input={{
            label: 'Message Duet',
            placeholder: 'Assign a task or ask anything…',
            /* This one is a bar on a page rather than a bar in a conversation,
               so there is no host height for the draft to take a share of and
               the ceiling has to be a number. The product's own mounts pass
               none — see `SessionComposerFooter`, which caps the whole composer
               at half of the thread's column and lets the draft find its own
               size under that. */
            maxHeight: 240,
          }}
          quality={{
            label: 'Quality',
            value: qualityId,
            options: qualityOptions,
            advanced: { label: 'Advanced', options: buildAdvancedQualityOptions() },
            onValueChange: setQualityId,
          }}
          reasoning={{
            label: 'Reasoning',
            icon: <BrainIcon />,
            value: reasoningId,
            options: reasoningLevels,
            onValueChange: setReasoningId,
          }}
          skills={{ items: skills, labels: SKILL_LABELS }}
          agents={{ items: agentsEmpty ? [] : agents, labels: AGENT_LABELS }}
          attachments={{
            items: attachments,
            onFilesSelected: files => {
              if (attachments.length >= 10) return false
              setAttachments(current => [
                ...current,
                ...files.map(file => ({
                  id: `${file.name}-${file.size}`,
                  name: file.name,
                  meta: `${file.type || 'File'} · ${file.size} B`,
                  status: { label: 'Ready', display: 'badge' as const },
                })),
              ])
              return true
            },
            onRemove: attachment => {
              setAttachments(current => current.filter(item => item.id !== attachment.id))
            },
            onRetry: attachment => {
              setAttachments(current =>
                current.map(item =>
                  item.id === attachment.id
                    ? { ...item, status: { label: 'Uploading · 0%' } }
                    : item,
                ),
              )
            },
            retryLabel: 'Retry',
            renderPreview: attachment =>
              attachment.name.endsWith('.png') ? (
                <span
                  aria-hidden
                  className="size-full bg-[radial-gradient(circle_at_35%_35%,theme(colors.sky.300),theme(colors.indigo.600)_70%)]"
                />
              ) : attachment.name.endsWith('.csv') ? (
                <span
                  aria-hidden
                  className="grid size-full grid-cols-3 gap-px bg-emerald-950/10 p-2"
                >
                  {['Market', 'Q1', 'Q2', 'North', '42', '51', 'West', '38', '47'].map(cell => (
                    <span
                      key={cell}
                      className="truncate rounded-[2px] bg-background/90 px-1 py-0.5 text-[10px] text-foreground/85"
                    >
                      {cell}
                    </span>
                  ))}
                </span>
              ) : attachment.name.endsWith('.txt') ? (
                <pre
                  aria-hidden
                  className="size-full overflow-hidden whitespace-pre-wrap p-2 font-mono text-[10px] leading-3.5 text-foreground/80"
                >
                  Clear, warm, and concise. Lead with the outcome.
                </pre>
              ) : undefined,
          }}
          actions={[
            {
              id: 'web-search',
              label: webSearchEnabled ? 'Disable web search' : 'Enable web search',
              icon: <GlobeIcon />,
              active: webSearchEnabled,
              onSelect: () => setWebSearchEnabled(enabled => !enabled),
            },
          ]}
          onSubmit={payload => {
            setLastSubmit(payload)
            setValue('')
            setAttachments([])
          }}
        />

        {/* What a `/` opens. Rendered from fixed props rather than by typing
            into the editor: driving the real caret into a baseline makes the
            shot depend on blink phase, and the popup is presentational either
            way. Off by default so every other compose-bar shot keeps its
            height. */}
        {skillsPreview ? (
          <div className="mt-10 space-y-3" data-testid="compose-bar-skills-preview">
            <p className="px-1 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Slash commands
            </p>
            {/* Each box reserves the height the popup draws into, with a
                bottom-anchored stand-in for the compose surface it hangs
                above — so the preview cannot climb over the real one. */}
            <div className="relative h-64">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={skillSuggestion}
                  labels={SKILL_LABELS}
                  loading={false}
                  continuation={{
                    loading: false,
                    unavailable: false,
                    onLoadMore: () => {},
                    labels: SKILL_CONTINUATION_LABELS,
                  }}
                />
                <ComposerStandIn />
              </div>
            </div>
            <div className="relative h-64">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={skillSuggestion}
                  labels={SKILL_LABELS}
                  loading={false}
                  continuation={{
                    loading: true,
                    unavailable: false,
                    onLoadMore: () => {},
                    labels: SKILL_CONTINUATION_LABELS,
                  }}
                />
                <ComposerStandIn />
              </div>
            </div>
            <div className="relative h-64">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={skillSuggestion}
                  labels={SKILL_LABELS}
                  loading={false}
                  continuation={{
                    loading: false,
                    unavailable: true,
                    onLoadMore: () => {},
                    labels: SKILL_CONTINUATION_LABELS,
                  }}
                />
                <ComposerStandIn />
              </div>
            </div>
            <div className="relative h-28">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={EMPTY_SUGGESTION}
                  labels={SKILL_LABELS}
                  loading={false}
                />
                <ComposerStandIn />
              </div>
            </div>
            {/* A workspace we could not reach must never read as one with no
                skills installed — the two lines are deliberately different. */}
            <div className="relative h-28">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={EMPTY_SUGGESTION}
                  labels={SKILL_LABELS}
                  loading={false}
                  unavailable
                />
                <ComposerStandIn />
              </div>
            </div>
          </div>
        ) : null}
        {/* The `@` roster. Its rows carry a second line the skills picker does
            not — the slug — because two colleagues can answer to one name and
            the name alone would leave them indistinguishable. A locked child is
            greyed and badged rather than struck through: it is still a real
            colleague, just not one to hand work to yet. */}
        {agentsPreview ? (
          <div className="mt-10 space-y-3" data-testid="compose-bar-agents-preview">
            <p className="px-1 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Agent mentions
            </p>
            <div className="relative h-64">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={agentSuggestion}
                  labels={AGENT_LABELS}
                  loading={false}
                />
                <ComposerStandIn />
              </div>
            </div>
            <div className="relative h-40">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={NONE_ELIGIBLE_SUGGESTION}
                  labels={AGENT_LABELS}
                  loading={false}
                />
                <ComposerStandIn />
              </div>
            </div>
            {/* A workspace with no agents registered yet is an answer; one we
                could not reach is not. */}
            <div className="relative h-28">
              <div className="absolute inset-x-0 bottom-0">
                <ComposeBarMentionPicker
                  suggestion={{ ...NONE_ELIGIBLE_SUGGESTION, items: [] }}
                  labels={AGENT_LABELS}
                  loading={false}
                />
                <ComposerStandIn />
              </div>
            </div>
          </div>
        ) : null}

        <output className="sr-only" data-testid="compose-bar-last-submit">
          {lastSubmit
            ? JSON.stringify({
                value: lastSubmit.value,
                qualityId: lastSubmit.qualityId,
                reasoningId: lastSubmit.reasoningId,
                attachmentNames: lastSubmit.attachments.map(attachment => attachment.name),
              })
            : 'No submission'}
        </output>
        <output className="sr-only" data-testid="compose-bar-session-action">
          {sessionAction}
        </output>
      </section>
    </main>
  )
}
