'use client'

import { Brain, CircleNotchIcon, WarningCircle, Wrench } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useState } from 'react'

import {
  INTEGRATIONS_MCP_SERVER_NAME,
  SESSION_TURN_END_REASONS,
  type SessionTurnEndReason,
} from '@repo/contract'
import { AIReasoning, AITrace, AITool } from '@repo/ui/components/ai-elements'

import type { AgentMessagePart } from './projection'
import { SessionMarkdown } from './session-markdown'

export function OrderedAgentParts({
  parts,
  cwd,
  workspaceSlug,
  fileUrl,
  agentName,
}: {
  parts: AgentMessagePart[]
  cwd: string | undefined
  workspaceSlug: string | undefined
  fileUrl: (drivePath: string) => string
  /** who wrote these parts; a question they ask is signed with it */
  agentName: string
}) {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <div className="min-w-0 space-y-3" data-agent-parts>
      {groupOrderedParts(parts).map(group =>
        group.kind === 'activity' ? (
          <ActivityGroup key={group.parts[0]!.id} parts={group.parts} t={t} />
        ) : (
          <AgentPart
            key={group.part.id}
            part={group.part}
            cwd={cwd}
            workspaceSlug={workspaceSlug}
            fileUrl={fileUrl}
            agentName={agentName}
          />
        ),
      )}
    </div>
  )
}

type ActivityPart = Extract<AgentMessagePart, { kind: 'reasoning' | 'tool' }>
type NonActivityPart = Exclude<AgentMessagePart, { kind: 'reasoning' | 'tool' }>

function groupOrderedParts(parts: AgentMessagePart[]) {
  const groups: Array<
    { kind: 'activity'; parts: ActivityPart[] } | { kind: 'part'; part: NonActivityPart }
  > = []

  for (const part of parts) {
    if (part.kind === 'reasoning' || part.kind === 'tool') {
      const previous = groups.at(-1)
      if (previous?.kind === 'activity') previous.parts.push(part)
      else groups.push({ kind: 'activity', parts: [part] })
    } else {
      groups.push({ kind: 'part', part })
    }
  }

  return groups
}

function ActivityGroup({
  parts,
  t,
}: {
  parts: ActivityPart[]
  t: ReturnType<typeof useTranslations<'duetApp.sessionProduct'>>
}) {
  const [open, setOpen] = useState(false)
  const busy = parts.some(part =>
    part.kind === 'reasoning' ? part.pending : part.status === 'running',
  )

  return (
    <AITrace
      title={t('activity')}
      description={activitySummary(parts, t)}
      icon={
        busy ? (
          <CircleNotchIcon
            className="size-3.5 text-brand motion-safe:animate-spin"
            aria-label={t('working')}
            aria-hidden={false}
            weight="bold"
          />
        ) : (
          <Brain className="size-3.5" aria-hidden />
        )
      }
      className="px-0"
      detailsProps={{
        'data-agent-activity': parts.map(part => part.id).join(','),
        onToggle: event => setOpen(event.currentTarget.open),
      }}
    >
      <div className="space-y-2">
        {parts.map(part => (
          <ActivityPart
            key={`${part.id}:${parts.length === 1 ? 'single' : 'many'}`}
            part={part}
            outerOpen={open}
            autoOpen={parts.length === 1}
            t={t}
          />
        ))}
      </div>
    </AITrace>
  )
}

function ActivityPart({
  part,
  outerOpen,
  autoOpen,
  t,
}: {
  part: ActivityPart
  outerOpen: boolean
  autoOpen: boolean
  t: ReturnType<typeof useTranslations<'duetApp.sessionProduct'>>
}) {
  const [partOpen, setPartOpen] = useState(autoOpen)

  if (part.kind === 'reasoning')
    return (
      <div data-agent-part-id={part.id} data-agent-part-kind="reasoning" className="min-w-0">
        <AIReasoning
          title={t('reasoning')}
          preview={reasoningPreview(part.text)}
          pendingLabel={part.pending ? t('working') : undefined}
          detailsProps={{
            open: partOpen,
            onToggle: event => setPartOpen(event.currentTarget.open),
          }}
        >
          <p className="mt-1 whitespace-pre-wrap border-l border-border/60 pl-3 text-sm italic leading-6 text-muted-foreground">
            {part.text}
          </p>
        </AIReasoning>
      </div>
    )

  return (
    <AITool
      name={part.name}
      source={
        part.server === undefined ? null : (
          <span
            data-tool-server={part.server}
            className="max-w-[45%] shrink-0 truncate rounded-full bg-muted px-1.5 text-[11px] font-medium leading-4 text-foreground/75"
          >
            {part.server === INTEGRATIONS_MCP_SERVER_NAME
              ? t('toolServerIntegrations')
              : part.server}
          </span>
        )
      }
      icon={<Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      status={part.status}
      statusLabel={
        part.status === 'running'
          ? t('toolRunning')
          : part.status === 'complete'
            ? t('toolComplete')
            : t('toolError')
      }
      className="group min-w-0"
      detailsProps={{
        open: partOpen,
        'data-agent-part-id': part.id,
        'data-agent-part-kind': 'tool',
        'data-tool-call-id': part.toolCallId,
        onToggle: event => setPartOpen(event.currentTarget.open),
      }}
    >
      {outerOpen && partOpen ? <ToolPayload part={part} /> : null}
    </AITool>
  )
}

function activitySummary(
  parts: ActivityPart[],
  t: ReturnType<typeof useTranslations<'duetApp.sessionProduct'>>,
) {
  if (parts.length === 1) {
    const part = parts[0]!
    return part.kind === 'reasoning' ? reasoningPreview(part.text) : part.name
  }
  return t('activitySteps', { count: parts.length })
}

function AgentPart({
  part,
  cwd,
  workspaceSlug,
  fileUrl,
  agentName,
}: {
  part: NonActivityPart
  cwd: string | undefined
  workspaceSlug: string | undefined
  fileUrl: (drivePath: string) => string
  agentName: string
}) {
  const statusT = useTranslations('duetApp.sessionProduct.turnStatus')
  const reasonT = useTranslations('duetApp.sessionProduct.turnEndedBecause')

  if (part.kind === 'text')
    return (
      <div data-agent-part-id={part.id} data-agent-part-kind="text" className="relative py-0.5">
        <SessionMarkdown
          text={part.text}
          cwd={cwd}
          workspaceSlug={workspaceSlug}
          fileUrl={fileUrl}
        />
      </div>
    )

  if (part.kind === 'ask') return <SessionQuestion part={part} agentName={agentName} />

  if (part.kind === 'system')
    return (
      <div
        data-agent-part-id={part.id}
        data-agent-part-kind="system"
        className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
      >
        <span className="h-px flex-1 bg-border/60" />
        <span className="min-w-0 break-words text-center">{part.message}</span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    )

  // A settled turn's answer already streamed as a text part, so the terminal
  // event only earns a row when it carries a failure the transcript lacks.
  if (part.type === 'complete' && part.error === undefined) return null

  const lifecycle = lifecyclePresentation(part)

  // A failed terminal is the one ending nobody chose: unlike a tool error
  // (signal the agent routes around) or an interrupt (someone pressed stop),
  // the turn died and its work is gone unless the reader acts. As a muted
  // divider it read as "the transcript just stops", so it alone wears the
  // alarm color.
  if (lifecycle.status === 'failed')
    return (
      <div
        data-agent-part-id={part.id}
        data-agent-part-kind="lifecycle"
        role="alert"
        className="my-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {/* min-w-0 + break-words for the same reason as the divider below: a
            provider's raw JSON error is one unbroken blob. */}
        <span className="min-w-0 break-words">
          <span className="font-medium">{statusT('failed')}</span>
          {lifecycle.detail ? ` · ${turnEndedBecause(lifecycle.detail, reasonT)}` : ''}
        </span>
      </div>
    )

  return (
    <div
      data-agent-part-id={part.id}
      data-agent-part-kind="lifecycle"
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border/60" />
      {/* A runner's error is free text, and a provider's raw JSON arrives as one
          unbroken blob thousands of characters long. A flex child will not
          shrink below its own content without `min-w-0`, so that blob took the
          whole chat pane sideways with it. */}
      <span className="min-w-0 break-words text-center">
        {lifecycle.status === undefined ? lifecycle.label : statusT(lifecycle.status)}
        {lifecycle.detail ? ` · ${turnEndedBecause(lifecycle.detail, reasonT)}` : ''}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  )
}

function reasoningPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function ToolPayload({ part }: { part: Extract<AgentMessagePart, { kind: 'tool' }> }) {
  const t = useTranslations('duetApp.sessionProduct')
  const hasInput = part.input !== undefined && Object.keys(part.input).length > 0
  const hasOutput = part.output !== undefined && part.output.length > 0

  if (!hasInput && part.details === undefined && !hasOutput) {
    return <p className="mt-2 pl-4 text-xs text-muted-foreground">{t('noToolDetails')}</p>
  }

  return (
    <div className="mt-2 space-y-3 border-l border-border/60 pl-4 text-xs">
      {hasInput ? <ToolSection label={t('toolInput')} value={part.input} /> : null}
      {part.details !== undefined ? (
        <ToolSection label={t('toolDetails')} value={part.details} />
      ) : null}
      {hasOutput ? (
        <section>
          <h3 className="mb-1 font-medium text-muted-foreground">{t('toolOutput')}</h3>
          <div className="space-y-2">
            {part.output?.map((output, index) =>
              output.type === 'text' ? (
                <pre
                  key={`${part.toolCallId}:text:${index}`}
                  className="whitespace-pre-wrap break-words rounded-md bg-muted/70 px-2.5 py-2 font-mono leading-5 text-foreground"
                >
                  {output.text}
                </pre>
              ) : (
                <Image
                  key={`${part.toolCallId}:image:${index}`}
                  unoptimized
                  src={`data:${output.mimeType};base64,${output.data}`}
                  alt={t('toolImageOutput')}
                  width={320}
                  height={180}
                  className="h-auto max-h-48 w-auto max-w-full rounded-md border border-border/70 bg-muted object-contain"
                />
              ),
            )}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function ToolSection({ label, value }: { label: string; value: unknown }) {
  return (
    <section>
      <h3 className="mb-1 font-medium text-muted-foreground">{label}</h3>
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/70 px-2.5 py-2 font-mono leading-5 text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  )
}

/* Signed by the agent that asked, and drawn in the ask tone every "needs you"
   mark wears (globals.css `--ask`). It used to be amber, which is the unread
   hue now, and it used to say "Duet" whoever was asking. */
function SessionQuestion({
  part,
  agentName,
}: {
  part: Extract<AgentMessagePart, { kind: 'ask' }>
  agentName: string
}) {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <div
      data-agent-part-id={part.id}
      data-agent-part-kind="ask"
      className="rounded-lg border border-ask/30 bg-ask/[0.06] px-3 py-2.5 text-foreground"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ask">
        {t('needsInput', { name: agentName })}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{questionText(part.questions)}</p>
    </div>
  )
}

// The control plane stamps the turns it ends itself with an operator code; a
// runner's own error is already prose. Translate what we minted, pass through
// what we did not.
function turnEndedBecause(detail: string, reasonT: (key: SessionTurnEndReason) => string): string {
  const reason = SESSION_TURN_END_REASONS.find(candidate => candidate === detail)
  return reason === undefined ? detail : reasonT(reason)
}

function lifecyclePresentation(part: Extract<AgentMessagePart, { kind: 'lifecycle' }>): {
  status?: 'cancelled' | 'failed' | 'interrupted' | 'sleep'
  label?: string
  detail?: string
} {
  switch (part.type) {
    case 'complete':
      return { status: part.status === 'cancelled' ? 'cancelled' : 'failed', detail: part.error }
    case 'interrupted':
      return { status: 'interrupted', detail: part.error }
    case 'sleep':
      return { status: 'sleep', detail: new Date(part.wakeAt).toLocaleString() }
  }
}

function questionText(questions: Extract<AgentMessagePart, { kind: 'ask' }>['questions']): string {
  return questions.map(question => question.question).join('\n')
}
