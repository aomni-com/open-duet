'use client'

import { type ReactElement, type ReactNode } from 'react'

import type { AgentPromptBehavior } from '@repo/contract'
import {
  ComposeBar,
  type ComposeBarProps,
  type ComposeBarAgents,
  type ComposeBarSkills,
  type ComposeBarSubmitPayload,
} from '@repo/ui/components/compose-bar'

export type SessionComposerMode = 'message' | 'note' | 'answer'

export type SessionComposerSubmitPayload<
  QualityId extends string = string,
  ReasoningId extends string = string,
> = ComposeBarSubmitPayload<QualityId, ReasoningId> &
  (
    | { mode: 'message'; behavior: AgentPromptBehavior }
    | { mode: Exclude<SessionComposerMode, 'message'>; behavior?: never }
  )

export type SessionComposerSubmissionResult = 'committed' | 'rejected'

type SessionComposerProps<QualityId extends string, ReasoningId extends string> = Omit<
  ComposeBarProps<QualityId, ReasoningId>,
  'onSubmit' | 'status' | 'skills' | 'agents'
> & {
  mode: SessionComposerMode
  /**
   * The `/` picker. Required rather than optional: every session composer
   * offers it, and a call site that could omit it is one that will. The data
   * still comes from the route — this component stays presentational.
   */
  skills: ComposeBarSkills
  /** The `@` picker. Required for the same reason as `skills`. */
  agents: ComposeBarAgents
  status?: ReactNode
  onSubmit: (
    payload: SessionComposerSubmitPayload<QualityId, ReasoningId>,
  ) => Promise<SessionComposerSubmissionResult>
}

function SessionComposerImpl<QualityId extends string, ReasoningId extends string>({
  mode,
  status,
  onSubmit,
  disabled = false,
  submitting = false,
  skills,
  agents,
  ...composeBarProps
}: SessionComposerProps<QualityId, ReasoningId>) {
  const submit = async (payload: ComposeBarSubmitPayload<QualityId, ReasoningId>) => {
    // The follow-up checkbox is hidden for now, so a message always steers the
    // running session; `behavior` stays on the wire for when it returns.
    await onSubmit(
      mode === 'message' ? { ...payload, mode, behavior: 'steer' } : { ...payload, mode },
    )
  }

  return (
    <ComposeBar
      {...composeBarProps}
      skills={skills}
      agents={agents}
      disabled={disabled}
      submitting={submitting}
      onSubmit={payload => void submit(payload)}
      status={status ? <span className="min-w-0 truncate">{status}</span> : undefined}
    />
  )
}

export const SessionComposer = SessionComposerImpl as <
  QualityId extends string = string,
  ReasoningId extends string = string,
>(
  props: SessionComposerProps<QualityId, ReasoningId>,
) => ReactElement
