'use client'

import { DotsThreeIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'

import type { Machine } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { RelayStatus } from '../../spa/relay/relay-status'

type HostWidth = 'roomy' | '520' | '380'

const HOST_WIDTH: Record<HostWidth, number> = {
  roomy: 960,
  '520': 520,
  '380': 380,
}

const FOCUSED_SUMMARY: Machine = {
  definitionName: 'Nightly customer export and delivery relay',
  currentState: 'Park until the export window opens',
  followingDefinitionState: 'Publish the verified export to the customer workspace',
  progress: { completed: 3, total: 7 },
  orderedPath: [
    { key: 'collect', index: 0, name: 'Collect records', kind: 'poll', phase: 'past' },
    { key: 'verify', index: 1, name: 'Verify records', kind: 'agent', phase: 'past' },
    { key: 'stage', index: 2, name: 'Stage export', kind: 'script', phase: 'past' },
    {
      key: 'park-current',
      index: 3,
      name: 'Park until the export window opens',
      kind: 'park',
      phase: 'current',
    },
    {
      key: 'publish',
      index: 4,
      name: 'Publish the verified export to the customer workspace',
      kind: 'script',
      phase: 'future',
    },
    { key: 'notify', index: 5, name: 'Notify owners', kind: 'agent', phase: 'future' },
    {
      key: 'complete',
      index: 6,
      name: 'Export delivered',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'completed',
    },
  ],
  activity: 'sleeping',
}

const COVERAGE_SUMMARIES: readonly { label: string; summary: Machine }[] = [
  relayCase('Agent', 'agent', 'running'),
  relayCase('Script', 'script', 'running'),
  relayCase('Poll', 'poll', 'waiting'),
  relayCase('Timer', 'timer', 'sleeping'),
  relayCase('Park', 'park', 'sleeping'),
  {
    label: 'Terminal',
    summary: {
      definitionName: 'Completed relay',
      currentState: 'done',
      progress: { completed: 4, total: 4 },
      orderedPath: [
        {
          key: 'done',
          index: 4,
          name: 'done',
          kind: 'terminal',
          phase: 'outcome',
          terminalStatus: 'completed',
        },
      ],
      activity: 'idle',
      outcome: 'completed',
    },
  },
  relayCase('Unknown kind', 'provider-specific', 'idle'),
  {
    label: 'Missing current',
    summary: {
      definitionName: 'Awaiting first runner snapshot',
      orderedPath: [
        { key: 'future', index: 0, name: 'Start work', kind: 'agent', phase: 'future' },
      ],
      activity: 'idle',
    },
  },
  {
    label: 'Repeated visit',
    summary: {
      definitionName: 'Approval retry relay',
      currentState: 'Wait for approval',
      followingDefinitionState: 'Apply approval',
      progress: { completed: 1, total: 3 },
      orderedPath: [
        {
          key: 'first-wait',
          index: 0,
          name: 'Wait for approval',
          kind: 'timer',
          phase: 'past',
        },
        {
          key: 'second-wait',
          index: 1,
          name: 'Wait for approval',
          kind: 'park',
          phase: 'current',
        },
        { key: 'apply', index: 2, name: 'Apply approval', kind: 'script', phase: 'future' },
      ],
      activity: 'sleeping',
    },
  },
]

export function SessionRelayCompactPlayground() {
  const [width, setWidth] = useState<HostWidth>('roomy')
  const hostStyle = { width: HOST_WIDTH[width], maxWidth: '100%' }

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
        <div className="sr-only" aria-label="Fixture controls">
          {(Object.keys(HOST_WIDTH) as HostWidth[]).map(candidate => (
            <button key={candidate} type="button" onClick={() => setWidth(candidate)}>
              Host width {candidate}
            </button>
          ))}
        </div>

        <section className="mx-auto max-w-5xl space-y-5" aria-label="Relay host pressure">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Session header · {width}
            </p>
            <div
              data-testid="relay-session-host"
              data-host-width={width}
              style={hostStyle}
              className="mt-2 flex min-h-14 flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2 shadow-sm sm:flex-nowrap sm:py-0"
            >
              <div className="min-w-0 flex-1 overflow-hidden" data-mask-host>
                <p className="truncate text-sm font-medium">Wait for the nightly export</p>
                <p className="truncate text-xs text-muted-foreground">Sleeping · Duet computer</p>
              </div>
              <RelayStatus
                summary={FOCUSED_SUMMARY}
                className="order-last w-full sm:order-none sm:w-[min(44rem,75%)]"
              />
              <button
                type="button"
                aria-label="Edit session"
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground"
                data-mask-host
              >
                <PencilSimpleIcon aria-hidden />
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Job row · {width}
            </p>
            <div
              data-testid="relay-job-host"
              data-host-width={width}
              style={hostStyle}
              className="mt-2 flex min-h-14 flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-2 shadow-sm sm:flex-nowrap sm:gap-4 sm:py-0"
            >
              <div className="min-w-0 flex-1 overflow-hidden" data-mask-host>
                <p className="truncate text-sm font-medium">Wait for the nightly export</p>
                <p className="text-xs text-muted-foreground">Updated today</p>
              </div>
              <RelayStatus
                summary={FOCUSED_SUMMARY}
                className="order-last w-full sm:order-none sm:w-[min(44rem,75%)]"
              />
              <DotsThreeIcon
                aria-hidden
                className="shrink-0 text-muted-foreground"
                data-mask-host
              />
            </div>
          </div>
        </section>

        <section
          aria-label="Relay state coverage"
          className="mx-auto mt-10 grid max-w-5xl gap-3 sm:grid-cols-2"
        >
          {COVERAGE_SUMMARIES.map(({ label, summary }) => (
            <article key={label} className="min-w-0 rounded-xl border border-border/60 bg-card p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <RelayStatus summary={summary} />
            </article>
          ))}
        </section>
      </main>
    </NextIntlClientProvider>
  )
}

function relayCase(
  label: string,
  kind: string,
  activity: Machine['activity'],
): { label: string; summary: Machine } {
  return {
    label,
    summary: {
      definitionName: `${label} relay`,
      currentState: `${label} current state`,
      followingDefinitionState: `${label} following state`,
      progress: { completed: 1, total: 3 },
      orderedPath: [
        { key: 'past', index: 0, name: 'Previous state', kind: 'agent', phase: 'past' },
        { key: 'current', index: 1, name: `${label} current state`, kind, phase: 'current' },
        { key: 'future', index: 2, name: `${label} following state`, phase: 'future' },
      ],
      activity,
    },
  }
}
