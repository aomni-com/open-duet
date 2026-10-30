'use client'

/* Hallmark · component: agent workbench · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * pre-emit critique: P5 H5 E5 S5 R5 V4
 */

import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  FolderIcon,
  GearSixIcon,
  GraduationCapIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react'
import { useRef, useState, type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { FixtureApp } from '../agent-surface-busy-fixture'
import { TeamSpaceAgentHistory } from './team-space-agent-history'
import { rosterForRoom, TeamSpaceComposer } from './team-space-composer'
import type { TeamAgent, TeamPullIn, TeamVerdict } from './team-space-fixture'
import { MemberFace } from './team-space-parts'
import { useWorkspace } from './team-space-workspace'

/** One turn of a two-party conversation. */
type Turn = { readonly id: string; readonly from: 'agent' | 'you'; readonly body: string }

type Face = { readonly key: string; readonly label: string; readonly icon: ReactNode }

/**
 * One agent, open in Build.
 *
 * Two panes, split by *what a pane is for* rather than by how many
 * destinations there are.
 *
 * The **left** is how you work on the agent — talk to it, read what it has
 * done, see what it has learned, check how it is configured. Those are
 * mutually exclusive by nature: you are doing one of them. So they are tabs,
 * and four of them, and the set never grows.
 *
 * The **right** is what the agent *holds* — its folder and the apps it ships.
 * That is not a mode you are in, it is the material you are working against,
 * so it stays on screen while you do any of the four. A builder tuning an
 * agent wants its instructions in front of them, not one click away.
 *
 * Two earlier arrangements got this wrong in opposite directions. A single
 * strip across the top of one pane put both kinds in one control and needed a
 * separator to admit they were different — and it wrapped the moment an agent
 * had a third app. A column of all seven fixed the growth and the grouping but
 * hid the files behind a click, which is the one thing that should never leave.
 *
 * What both of those and this all give up is seeing History and the
 * conversation at once. It is bought back the same way: marking an answer wrong
 * carries you to Chat with that answer already quoted, so the loop is a
 * deliberate change of task — stop auditing, start teaching — rather than
 * something done out of the corner of the eye.
 */
export function TeamSpaceAgentSurface({
  agent,
  initialFace = 'history',
}: {
  agent: TeamAgent
  initialFace?: string
}) {
  const workspace = useWorkspace()
  const apps = workspace.apps.filter(app => app.ownerAgentId === agent.id)
  const [face, setFace] = useState(initialFace)
  const [verdicts, setVerdicts] = useState<Record<string, TeamVerdict>>({})
  const [broughtId, setBroughtId] = useState<string | undefined>(undefined)
  const [value, setValue] = useState('')
  const [turns, setTurns] = useState<readonly Turn[]>(openingFor)
  const scroller = useRef<HTMLDivElement>(null)

  /* Working on the agent. Four, fixed, mutually exclusive. */
  const modes: readonly Face[] = [
    { key: 'tuning', label: 'Chat', icon: <ChatCircleIcon /> },
    { key: 'history', label: 'History', icon: <ClockCounterClockwiseIcon /> },
    { key: 'train', label: 'Train', icon: <GraduationCapIcon /> },
    { key: 'settings', label: 'Settings', icon: <GearSixIcon /> },
  ]
  /* What the agent holds. Grows with the agent, and never leaves the screen. */
  const holds: readonly Face[] = [
    { key: 'files', label: 'Files', icon: <FolderIcon /> },
    ...apps.map(app => ({ key: app.id, label: app.name, icon: <SquaresFourIcon /> })),
  ]
  const [held, setHeld] = useState(holds[0]?.key ?? 'files')

  /* Quoting rather than copying: the agent has to be able to tell which of its
     own answers is being talked about, and a bare paragraph of its own prose
     handed back is ambiguous the moment it has said something similar twice. */
  const quote = (entry: TeamPullIn) =>
    `> ${entry.output}\n> — ${entry.day} ${entry.at}, in ${
      workspace.sessions.find(session => session.id === entry.chatId)?.title ?? 'a chat'
    }\n\n`

  const carryIntoTuning = (entry: TeamPullIn, opener = '') => {
    setBroughtId(entry.id)
    setValue(current => (current.includes(entry.output) ? current : quote(entry) + opener))
    setFace('tuning')
  }

  const markVerdict = (entry: TeamPullIn, verdict: TeamVerdict) => {
    setVerdicts(current => ({ ...current, [entry.id]: verdict }))
    /* Asymmetric on purpose. "Right" is complete as a mark and leaves you where
       you were, still auditing. "Wrong" is not — a bit tells the agent
       something failed and nothing about what to do instead — so it carries you
       to the one place where you can say what should have happened. */
    if (verdict === 'wrong') carryIntoTuning(entry, 'This was wrong because ')
  }

  const send = (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    setTurns(current => [
      ...current,
      { id: `t-${current.length}`, from: 'you', body: trimmed },
      {
        id: `t-${current.length}-ack`,
        from: 'agent',
        body: 'Noted — I have kept that as a standing rule rather than a one-off. It is on Train.',
      },
    ])
    setValue('')
    setBroughtId(undefined)
    requestAnimationFrame(() => {
      const pane = scroller.current
      if (pane !== null) pane.scrollTop = pane.scrollHeight
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4 lg:flex-row lg:p-5">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/75 bg-card">
        {/* Identity and the four ways of working on it, in one band. The agent
            is named here rather than over both panes because only this side is
            scoped to it — the pane opposite is scoped to a file. */}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2">
          <span className="flex shrink-0 items-center gap-2 px-1">
            <MemberFace member={{ kind: 'agent', ...agent }} className="size-6" />
            <span className="truncate text-sm font-semibold">{agent.name}</span>
          </span>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          <div role="tablist" aria-label={`${agent.name} views`} className="flex flex-wrap gap-0.5">
            {modes.map(item => (
              <TabButton
                key={item.key}
                item={item}
                on={face === item.key}
                onSelect={() => setFace(item.key)}
              />
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {face === 'tuning' ? (
            <div className="flex h-full min-h-0 flex-col">
              <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <div className="flex min-h-full flex-col justify-end gap-3">
                  {turns.map(turn => (
                    <TurnRow key={turn.id} turn={turn} />
                  ))}
                </div>
              </div>
              <div className="shrink-0 border-t border-border/60 px-4 py-3">
                <TeamSpaceComposer
                  value={value}
                  onValueChange={setValue}
                  label={`Tell ${agent.name} what to do differently`}
                  roster={rosterForRoom(workspace, [agent.id])}
                  placeholder={`Tell ${agent.name} what to do differently…`}
                  onSubmitted={send}
                  status={<span className="hidden sm:inline">Only you and {agent.name}</span>}
                />
              </div>
            </div>
          ) : face === 'history' ? (
            <TeamSpaceAgentHistory
              agentId={agent.id}
              verdicts={verdicts}
              onVerdict={markVerdict}
              onBringIntoChat={entry => carryIntoTuning(entry)}
              broughtId={broughtId}
            />
          ) : face === 'train' ? (
            <TrainPane agent={agent} />
          ) : (
            <SettingsPane agent={agent} />
          )}
        </div>
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/75 bg-card">
        <div
          role="tablist"
          aria-label={`${agent.name} files and apps`}
          className="flex min-h-14 shrink-0 flex-wrap items-center gap-0.5 border-b border-border/60 px-3 py-2"
        >
          {holds.map(item => (
            <TabButton
              key={item.key}
              item={item}
              on={held === item.key}
              onSelect={() => setHeld(item.key)}
            />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {held === 'files' ? (
            <FilesPane agentSlug={agent.slug} />
          ) : (
            <div className="h-full overflow-y-auto">
              <FixtureApp title={holds.find(item => item.key === held)?.label ?? 'App'} />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function TabButton({ item, on, onSelect }: { item: Face; on: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onSelect}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px [&_svg]:size-3.5',
        on
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {item.icon}
      {item.label}
    </button>
  )
}

/**
 * A turn, in the shape a two-party conversation wants.
 *
 * No portrait, no name, no role badge. Those exist in a room because a room has
 * five people in it and a reader has to know who said what; here there are two
 * parties and the side of the column already says which.
 */
function TurnRow({ turn }: { turn: Turn }) {
  const lines = turn.body.split('\n')
  const quoted = lines.filter(line => line.startsWith('>')).map(line => line.replace(/^>\s?/, ''))
  const rest = lines
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .trim()

  if (turn.from === 'agent') {
    return <p className="text-sm leading-6 text-foreground">{turn.body}</p>
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2">
        {quoted.length > 0 ? (
          <p className="mb-1.5 border-l-2 border-border pl-2 text-xs leading-5 text-muted-foreground">
            {quoted.join(' ')}
          </p>
        ) : null}
        {rest.length > 0 ? <p className="text-sm leading-6">{rest}</p> : null}
      </div>
    </div>
  )
}

/** What the agent is, as the builder configured it. */
function SettingsPane({ agent }: { agent: TeamAgent }) {
  const rows = [
    { label: 'Name', value: agent.name },
    { label: 'Address', value: `@${agent.slug}` },
    { label: 'What it is for', value: agent.blurb },
    { label: 'Answers through', value: 'Duet — it never replies in a chat directly' },
    { label: 'Quality', value: 'Standard' },
    { label: 'Reachable by', value: 'Everyone in this workspace' },
  ]
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <dl className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/75">
        {rows.map(row => (
          <div key={row.label} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-sm">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * What the agent has been taught, and where each rule came from.
 *
 * The other end of the loop. A correction argued out in Tuning is worth nothing
 * if it evaporates when the tab closes; this is where it lands, with the answer
 * that caused it still attached so anybody can see whether the rule was a fair
 * reading of it.
 */
function TrainPane({ agent }: { agent: TeamAgent }) {
  const rules = [
    {
      rule: 'On any variance over 5%, name the account before the number.',
      from: 'Priya, Monday — the board reads the account first.',
    },
    {
      rule: 'Check the contract before calling something an exception.',
      from: 'Marked wrong on the Kestrel invoice, today.',
    },
    {
      rule: 'Answer in one line when the question is one line.',
      from: 'Marked right on the MSA billing term, today.',
    },
  ]
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div>
        <h2 className="text-sm font-semibold">Standing rules</h2>
        <p className="mt-1 max-w-[62ch] text-xs leading-5 text-muted-foreground">
          {rules.length} things {agent.name} checks before it answers anywhere in this workspace.
          Each one came out of a correction.
        </p>
        <ol className="mt-4 space-y-2">
          {rules.map(item => (
            <li key={item.rule} className="rounded-lg border border-border/75 px-3 py-2.5">
              <p className="text-sm leading-6">{item.rule}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.from}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

/** The agent's own folder. A stand-in — what it holds is not this mock's argument. */
function FilesPane({ agentSlug }: { agentSlug: string }) {
  const rows = [
    { name: 'instructions.md', meta: 'Note · edited 2 days ago' },
    { name: 'examples/', meta: 'Folder · 8 items' },
    { name: 'close-checklist.md', meta: 'Note · edited yesterday' },
  ]
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div>
        <p className="pb-3 font-mono text-[11px] text-muted-foreground">agents/{agentSlug}</p>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/75">
          {rows.map(row => (
            <li key={row.name} className="flex items-center gap-3 px-3 py-2.5">
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{row.meta}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** How the tuning conversation opens: with what the loop has already produced. */
function openingFor(): readonly Turn[] {
  return [
    {
      id: 't-open',
      from: 'agent',
      body: `This is where you tell me what to do differently. Anything settled here changes how I answer everywhere — mark an answer wrong on History and it lands here with the answer quoted, and I will keep what you say as a rule rather than a one-off.`,
    },
    {
      id: 't-1',
      from: 'you',
      body: 'When a variance is over 5%, always name the account before the number. The board reads the account first.',
    },
    {
      id: 't-1-ack',
      from: 'agent',
      body: `Noted — account first, then the number, on anything over 5%. That is a standing rule now, not a preference for one pack.`,
    },
  ]
}
