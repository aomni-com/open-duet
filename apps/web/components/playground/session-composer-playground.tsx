'use client'

import Image from 'next/image'
import { useState } from 'react'

import { buildTierQualityOptions } from '../../spa/model-tiers/tier-quality-options'
import {
  SessionComposer,
  type SessionComposerMode,
  type SessionComposerSubmitPayload,
  type SessionComposerSubmissionResult,
} from '../../spa/sessions/session-composer'

type Disposition = 'accepted' | 'queued' | 'failed' | 'pending'
type Surface = 'new' | 'existing'

const QUALITY_OPTIONS = buildTierQualityOptions()

/* This fixture is about the composer's modes and dispositions, not the picker,
   so the capability is present and empty: `/` opens nothing rather than
   reaching for a workspace this playground has no client for. */
const FIXTURE_SKILLS = {
  items: [],
  labels: {
    list: 'Skills',
    loading: 'Loading skills…',
    empty: 'No matching skills',
    unavailable: "Couldn't reach your workspace",
  },
} as const

/* The same shape for `@`: present and empty, so the trigger is wired without
   this fixture needing a workspace to read a roster from. */
const FIXTURE_AGENTS = {
  items: [],
  labels: {
    list: 'Agents',
    loading: 'Loading agents…',
    empty: 'No agents yet',
    unavailable: "Couldn't reach your workspace",
  },
} as const

export function SessionComposerPlayground() {
  return (
    <main className="min-h-screen bg-muted/20 px-3 py-10 text-foreground sm:px-8 sm:py-16">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="px-1">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
            Session prompt intent
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Talk to a session</h1>
        </div>
        <ComposerHarness surface="new" />
        <ComposerHarness surface="existing" />
      </div>
    </main>
  )
}

function ComposerHarness({ surface }: { surface: Surface }) {
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<SessionComposerMode>('message')
  const [disposition, setDisposition] = useState<Disposition>('accepted')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const [lastSubmit, setLastSubmit] = useState<Record<string, string> | null>(null)

  const submit = async (
    payload: SessionComposerSubmitPayload,
  ): Promise<SessionComposerSubmissionResult> => {
    const submittedValue = payload.value
    setError(false)
    setSubmitting(true)
    setValue('')
    setLastSubmit({
      value: submittedValue,
      mode: payload.mode,
      ...(payload.behavior === undefined ? {} : { behavior: payload.behavior }),
      surface,
    })

    if (disposition === 'pending') return await new Promise(() => {})

    setSubmitting(false)
    if (disposition === 'failed') {
      setValue(submittedValue)
      setError(true)
      return 'rejected'
    }
    return 'committed'
  }

  const label = surface === 'new' ? 'New session composer' : 'Existing session composer'
  return (
    <section aria-label={label} className="rounded-2xl border bg-background p-3 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-medium">{label}</h2>
        <div className="flex flex-wrap gap-1">
          {surface === 'existing'
            ? (['message', 'note', 'answer'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  className="rounded-md border px-2 py-1 text-xs aria-pressed:bg-muted"
                  onClick={() => setMode(option)}
                >
                  {option[0]!.toUpperCase() + option.slice(1)}
                </button>
              ))
            : null}
          {(['accepted', 'queued', 'failed', 'pending'] as const).map(option => (
            <button
              key={option}
              type="button"
              aria-label={`${label} disposition: ${option}`}
              aria-pressed={disposition === option}
              className="sr-only"
              onClick={() => setDisposition(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <SessionComposer
        skills={FIXTURE_SKILLS}
        agents={FIXTURE_AGENTS}
        mode={surface === 'new' ? 'message' : mode}
        value={value}
        onValueChange={setValue}
        onSubmit={submit}
        input={{
          label:
            mode === 'note'
              ? 'Add a note'
              : mode === 'answer'
                ? 'Answer Duet'
                : surface === 'new'
                  ? 'Describe a task for Duet'
                  : 'Message Duet',
          placeholder: surface === 'new' ? 'Describe a task for Duet…' : 'Continue this session…',
          variant: surface === 'new' ? 'prominent' : 'default',
          maxHeight: 160,
        }}
        submitting={submitting}
        quality={
          mode === 'message'
            ? {
                label: 'Quality',
                value: 'balanced',
                options: QUALITY_OPTIONS,
                onValueChange: () => {},
              }
            : undefined
        }
        aiToggle={
          surface === 'new' || mode === 'answer'
            ? undefined
            : {
                label: 'Ask Duet',
                enabled: mode === 'message',
                onEnabledChange: enabled => setMode(enabled ? 'message' : 'note'),
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
        status={submitting ? 'Sending…' : undefined}
        submit={{ label: surface === 'new' ? 'Start' : 'Send', submittingLabel: 'Sending…' }}
        banner={error ? <p role="alert">That action could not be completed.</p> : undefined}
      />

      <output className="sr-only" data-testid="submitted-payload">
        {lastSubmit ? JSON.stringify(lastSubmit) : 'No submission'}
      </output>
    </section>
  )
}
