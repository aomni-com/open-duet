'use client'

import { BriefcaseIcon, XIcon } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'

import { SESSION_ACTIVITY_PRIORITY, type SessionBucket } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import appEn from '../../../messages/en/app.json'
import { jobsForChat, type TeamJob } from './team-space-fixture'
import { MemberFace, StatusDot } from './team-space-parts'
import { useWorkspace, useMember } from './team-space-workspace'

/* The shipped headings, not hand-written lookalikes. A fixture that asserts its
   own copy verifies text no user will ever read, and the two drift. */
const GROUP_LABELS = appEn.duetApp.agentSurface.groups as Record<SessionBucket, string>

const GROUP_TONES: Record<SessionBucket, 'asking' | 'live' | 'sleeping' | undefined> = {
  asking: 'asking',
  running: 'live',
  scheduled: 'sleeping',
  done: undefined,
}

/**
 * Everything this chat handed off, beside the chat that handed it off.
 *
 * The rail is an index, not a second conversation: it answers "what did this
 * room set in motion, and is any of it stuck on me" and then gets out of the
 * way. Reading order is the contract's — `SESSION_ACTIVITY_PRIORITY`, asking
 * first, because a question waiting on a person is the only state the reader
 * can clear and it must not be filed under whatever the machine is doing.
 *
 * The chat itself is never in here. It is a session like its jobs are, but it
 * has the whole pane next door; listing it would draw the conversation as work
 * inside the panel built to list work beside it.
 */
export function TeamSpaceJobsRail({
  chatId,
  openJobId,
  onOpenJob,
  onClose,
}: {
  chatId: string
  openJobId?: string
  onOpenJob: (jobId: string) => void
  onClose?: () => void
}) {
  const workspace = useWorkspace()
  const [from, setFrom] = useState<string | undefined>(undefined)
  const all = jobsForChat(workspace, chatId)

  /* One job's worth of choice is not a choice. A filter that can only be set to
     the value it already has is furniture, so it appears only on a chat that
     actually handed work to more than one dispatcher. */
  const dispatchers = [...new Set(all.map(job => job.dispatchedById))]
  const filtered = from === undefined ? all : all.filter(job => job.dispatchedById === from)

  const groups = SESSION_ACTIVITY_PRIORITY.map(key => ({
    key,
    jobs: filtered.filter(job => job.state === key),
  })).filter(group => group.jobs.length > 0)

  return (
    <aside className="flex w-full shrink-0 flex-col border-border/70 bg-sidebar lg:w-[19rem] lg:border-l">
      {/* `px-4` against rows that sit at `px-2` inside a `px-2` scroller: both
          land their content 16px from the panel edge, so the heading and the
          rows under it read as one column rather than two. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <BriefcaseIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Jobs</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide jobs"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>

      {dispatchers.length > 1 ? (
        <FromFilter dispatchers={dispatchers} value={from} onChange={setFrom} />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {groups.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
            {all.length === 0
              ? 'Nothing has been handed off in this chat yet. Ask an agent for something that takes a while and it will show up here.'
              : 'Nothing here was handed over by them.'}
          </p>
        ) : (
          groups.map(group => (
            <section key={group.key} className="mt-3 first:mt-1">
              <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {GROUP_LABELS[group.key]}
              </h3>
              <div className="space-y-0.5">
                {group.jobs.map(job => (
                  <JobRow
                    key={job.id}
                    job={job}
                    open={job.id === openJobId}
                    onSelect={() => onOpenJob(job.id)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

/**
 * Who handed the work over.
 *
 * The one axis worth filtering a chat's jobs on, because it is the one a reader
 * arrives with a question about — *what did I set running*, or *what has Duet
 * been doing on its own*. State is already the grouping and needs no control,
 * and the agent doing the work is on every row.
 *
 * Chips with faces rather than a select: there are two or three of them, they
 * are people and agents the reader already recognises by face everywhere else
 * on this surface, and a menu would hide a two-item choice behind a click.
 */
function FromFilter({
  dispatchers,
  value,
  onChange,
}: {
  dispatchers: readonly string[]
  value: string | undefined
  onChange: (id: string | undefined) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
        From
      </span>
      <FromChip selected={value === undefined} onSelect={() => onChange(undefined)}>
        Anyone
      </FromChip>
      {dispatchers.map(id => (
        <FromChipFor key={id} id={id} selected={value === id} onSelect={() => onChange(id)} />
      ))}
    </div>
  )
}

function FromChipFor({
  id,
  selected,
  onSelect,
}: {
  id: string
  selected: boolean
  onSelect: () => void
}) {
  const member = useMember(id)
  if (member === undefined) return null
  return (
    <FromChip selected={selected} onSelect={onSelect}>
      <MemberFace member={member} className="size-4" />
      {member.name.split(' ')[0]}
    </FromChip>
  )
}

function FromChip({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
        selected
          ? 'border-transparent bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'border-border/70 text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function JobRow({ job, open, onSelect }: { job: TeamJob; open: boolean; onSelect: () => void }) {
  const agent = useMember(job.agentId)
  const owner = useMember('duet')
  const tone = GROUP_TONES[job.state]
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={open ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        open ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60',
        job.state === 'done' && !open && 'opacity-70',
      )}
    >
      {/* Two faces, always: the orchestrator that owns the handoff and the
          agent actually doing it. A job on this workspace is never one agent's
          — Duet took the request and passed it on, and a single face would
          name whichever half of that the row happened to store. */}
      <span className="mt-0.5 flex shrink-0 items-center -space-x-1.5">
        {owner ? <MemberFace member={owner} className="size-5 ring-2 ring-sidebar" /> : null}
        {agent !== undefined && agent.id !== owner?.id ? (
          <MemberFace member={agent} className="size-5 ring-2 ring-sidebar" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs leading-5',
              job.unread === true ? 'font-semibold text-foreground' : 'font-medium',
            )}
          >
            {job.title}
          </span>
          {tone !== undefined ? <StatusDot tone={tone} /> : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">
            {agent === undefined || agent.id === owner?.id
              ? owner?.name
              : `${owner?.name} → ${agent.name}`}
          </span>
          <span aria-hidden>·</span>
          <span className="shrink-0 whitespace-nowrap tabular-nums">{job.note}</span>
        </span>
      </span>
    </button>
  )
}
