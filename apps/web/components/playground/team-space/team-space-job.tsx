'use client'

import { ArrowUUpLeftIcon, CaretRightIcon, DotsThreeIcon, StopIcon } from '@phosphor-icons/react'
import { useRef, useState } from 'react'

import type { SessionBucket } from '@repo/contract'
import type { ComposeBarSession } from '@repo/ui/components/compose-bar'
import { cn } from '@repo/ui/lib/utils'

import { TeamSpaceComposer, rosterForRoom } from './team-space-composer'
import type { TeamJob, TeamSession } from './team-space-fixture'
import { MemberFace, statePillClass, StatusDot } from './team-space-parts'
import { ArtifactCard, StepRow, Transcript, usePinnedToBottom } from './team-space-transcript'
import { useWorkspace, useMember } from './team-space-workspace'

/**
 * One job, open.
 *
 * A job is a session, so this is a conversation and is drawn by the same rows
 * the chat next door is. What has to be different is everything *around* those
 * rows, because the two mistakes a reader can make here are expensive: not
 * realising they have left the room, and not realising that what they type is
 * not going back to it.
 *
 * Four things carry that, in descending order of how much work they do:
 *
 *  1. **The header does not scroll.** The task and its checklist are pinned
 *     above the transcript, so the answer to "what am I in" is on screen the
 *     whole time rather than at the top of a scroll.
 *  2. **The ground changes.** The pane sits on `muted` where the chat sits on
 *     `background` — not a different palette, just a different surface, which
 *     is what peripheral vision reads.
 *  3. **The parent is named in the breadcrumb**, and it is the way back.
 *  4. **The composer says who is listening.** A reply here steers this agent
 *     and nobody in the chat sees it. That is the whole reason the level
 *     exists, and it is the one thing a person cannot infer from the layout —
 *     so it is written down rather than implied.
 *
 * And because a side conversation that cannot rejoin the main one is a dead
 * end, the header carries the way back out: **Post to chat** takes the job's
 * result into the room it came from.
 */
export function TeamSpaceJob({
  chat,
  job,
  onBack,
  backLabel,
  showParent = false,
}: {
  chat: TeamSession
  job: TeamJob
  onBack: () => void
  /**
   * What the breadcrumb points at. Defaults to the chat, because that is where
   * the reader came from when jobs live in a rail beside it. The arrangement
   * where jobs are their own place passes the list instead — and then has to
   * name the chat somewhere else, which is what `showParent` is for.
   */
  backLabel?: string
  showParent?: boolean
}) {
  const workspace = useWorkspace()
  const [value, setValue] = useState('')
  const pane = useRef<HTMLDivElement>(null)
  usePinnedToBottom(pane, job.id)

  const agent = useMember(job.agentId)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/45 dark:bg-muted/25">
      <header className="flex h-12 shrink-0 items-center border-b border-border/70">
        <div className="mx-auto flex w-full max-w-[52rem] items-center gap-1.5 px-4 md:px-6">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowUUpLeftIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 max-w-[14rem] truncate">{backLabel ?? chat.title}</span>
          </button>
          <CaretRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
          {/* The word, not the title. The title is in the pinned header a
            centimetre below and does not need saying twice; what the breadcrumb
            is for is the level — you are one down from a chat, and here is the
            chat. */}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">Job</span>
          <JobStatePill state={job.state} />
          <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
            <DotsThreeIcon className="size-4" />
          </span>
        </div>
      </header>

      {/* Pinned, not scrolled: this is the answer to "what am I in", and it has
          to survive reading the conversation under it. */}
      <div className="shrink-0 border-b border-border/70 bg-background px-4 py-3.5 md:px-6">
        <div className="mx-auto w-full max-w-[52rem]">
          {/* Wraps rather than squeezes: on a phone the controls take a line of
              their own instead of crushing the title into three. */}
          <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
            {agent ? <MemberFace member={agent} className="mt-0.5 size-9" /> : null}
            <div className="min-w-0 flex-1 basis-[14rem]">
              <h1 className="min-w-0 text-sm font-semibold leading-5">{job.title}</h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/70">{agent?.name}</span>
                {' · '}
                {showParent ? `in ${chat.title} · ` : ''}
                {job.meta}
              </p>
            </div>
            <div className="ml-12 flex shrink-0 items-center gap-1.5 sm:ml-0">
              {job.state === 'running' ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <StopIcon className="size-3" />
                  Stop
                </button>
              ) : null}
              {/* The way back out. A side conversation that cannot rejoin the
                  main one is a dead end — this is how the job's answer becomes
                  something the room can see. */}
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
              >
                Post to chat
              </button>
            </div>
          </div>

          {job.steps !== undefined ? (
            <div className="mt-3 space-y-1.5 sm:pl-12">
              {job.steps.map(step => (
                <StepRow key={step.label} label={step.label} state={step.state} />
              ))}
            </div>
          ) : null}

          {job.artifacts !== undefined ? (
            <div className="mt-3 flex flex-wrap gap-2 sm:pl-12">
              {job.artifacts.map(artifact => (
                <ArtifactCard key={artifact.id} artifact={artifact} />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div ref={pane} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[52rem] pb-6 pt-3">
          {/* Who opened it and when is in the header above; the one fact that
              is not inferable from any of the layout is who can read this. */}
          <p className="px-4 pb-2 text-[11px] text-muted-foreground md:px-6">
            Only people who open this job see what is said here.
          </p>
          <Transcript entries={job.entries} />
        </div>
      </div>

      <div className="shrink-0 pb-4 pt-1">
        <div className="relative mx-auto w-full max-w-[52rem] px-4 md:px-6">
          <TeamSpaceComposer
            value={value}
            onValueChange={setValue}
            label={`Steer ${agent?.name ?? 'this job'}`}
            roster={rosterForRoom(workspace, chat.memberIds)}
            placeholder={`Steer ${agent?.name ?? 'this job'}…`}
            session={jobComposerSession(job)}
            status={
              <span className="hidden sm:inline">
                Replies stay in this job. Use Post to chat to take it back to {chat.title}.
              </span>
            }
          />
        </div>
      </div>
    </div>
  )
}

/** The state, said once at the top in the same words the rail files it under. */
function JobStatePill({ state }: { state: SessionBucket }) {
  const copy: Record<SessionBucket, string> = {
    asking: 'Needs you',
    running: 'Running',
    scheduled: 'On a clock',
    done: 'Finished',
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        statePillClass(state),
      )}
    >
      {state === 'asking' ? <StatusDot tone="asking" /> : null}
      {state === 'running' ? <StatusDot tone="live" /> : null}
      {state === 'scheduled' ? <StatusDot tone="sleeping" /> : null}
      {copy[state]}
    </span>
  )
}

function jobComposerSession(job: TeamJob): ComposeBarSession | undefined {
  if (job.state === 'asking' && job.question !== undefined) {
    return {
      key: `${job.id}:asking`,
      phase: 'waiting',
      label: 'Waiting on you',
      tone: 'text-[var(--km-ask,#bc3a22)]',
      question: job.question,
    }
  }
  if (job.state === 'scheduled') {
    return {
      key: `${job.id}:scheduled`,
      phase: 'sleeping',
      label: job.meta,
      tone: 'text-muted-foreground',
      hint: 'Anything you say here is waiting for it when it wakes.',
    }
  }
  return undefined
}
