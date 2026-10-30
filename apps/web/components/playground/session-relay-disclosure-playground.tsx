'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'

import type { Machine } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { RelayStatus } from '../../spa/relay/relay-status'

const LONG_RELAY: Machine = {
  definitionName: 'Nightly Customer Export and Delivery Relay',
  currentState: 'Wait for the delivery window',
  followingDefinitionState: 'Publish the verified export',
  progress: { completed: 7, total: 11 },
  orderedPath: [
    { key: 'collect', index: 0, name: 'Collect records', kind: 'poll', phase: 'past' },
    { key: 'normalize', index: 1, name: 'Normalize records', kind: 'script', phase: 'past' },
    { key: 'review', index: 2, name: 'Review exceptions', kind: 'agent', phase: 'past' },
    { key: 'retry-one', index: 3, name: 'Wait for approval', kind: 'timer', phase: 'past' },
    { key: 'apply', index: 4, name: 'Apply approval', kind: 'script', phase: 'past' },
    { key: 'stage', index: 5, name: 'Stage export', kind: 'script', phase: 'past' },
    { key: 'verify', index: 6, name: 'Verify export', kind: 'agent', phase: 'past' },
    {
      key: 'retry-two',
      index: 7,
      name: 'Wait for the delivery window',
      kind: 'park',
      phase: 'current',
    },
    {
      key: 'publish',
      index: 8,
      name: 'Publish the verified export',
      kind: 'script',
      phase: 'future',
    },
    { key: 'notify', index: 9, name: 'Notify owners', kind: 'provider-specific', phase: 'future' },
    {
      key: 'complete',
      index: 10,
      name: 'Export delivered',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'completed',
    },
  ],
  activity: 'sleeping',
}

const SHORT_RELAY: Machine = {
  definitionName: 'Quick Status Relay',
  currentState: 'Check status',
  followingDefinitionState: 'Report result',
  progress: { completed: 0, total: 3 },
  orderedPath: [
    { key: 'check', index: 0, name: 'Check status', kind: 'poll', phase: 'current' },
    { key: 'report', index: 1, name: 'Report result', kind: 'agent', phase: 'future' },
    {
      key: 'done',
      index: 2,
      name: 'Status reported',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'completed',
    },
  ],
  activity: 'running',
}

const TERMINAL_RELAY: Machine = {
  definitionName: 'Delivery Relay With Outcomes',
  currentState: 'Delivery failed',
  progress: { completed: 3, total: 6 },
  orderedPath: [
    { key: 'prepare', index: 0, name: 'Prepare delivery', kind: 'agent', phase: 'past' },
    { key: 'send', index: 1, name: 'Send delivery', kind: 'script', phase: 'past' },
    {
      key: 'success',
      index: 3,
      name: 'Delivery completed',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'completed',
    },
    {
      key: 'failure',
      index: 4,
      name: 'Delivery failed',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'failed',
    },
    {
      key: 'cancelled',
      index: 5,
      name: 'Delivery cancelled',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'cancelled',
    },
  ],
  activity: 'idle',
  outcome: 'failed',
}

const REPEATED_RELAY: Machine = {
  definitionName: 'Approval Retry Relay',
  currentState: 'Wait for approval',
  followingDefinitionState: 'Apply approval',
  progress: { completed: 1, total: 3 },
  orderedPath: [
    { key: 'first-wait', index: 0, name: 'Wait for approval', kind: 'timer', phase: 'past' },
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
}

const UNKNOWN_RELAY: Machine = {
  definitionName: 'Provider Extension Relay',
  currentState: 'Run provider extension',
  progress: { completed: 0, total: 1 },
  orderedPath: [
    {
      key: 'extension',
      index: 0,
      name: 'Run provider extension',
      kind: 'provider-specific',
      phase: 'current',
    },
  ],
  activity: 'waiting',
}

const RELAY_CASES = {
  long: LONG_RELAY,
  short: SHORT_RELAY,
  terminal: TERMINAL_RELAY,
  repeated: REPEATED_RELAY,
  unknown: UNKNOWN_RELAY,
} as const

type RelayCase = keyof typeof RELAY_CASES

export function SessionRelayDisclosurePlayground() {
  const [relayCase, setRelayCase] = useState<RelayCase>('long')
  const summary = RELAY_CASES[relayCase]

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <main className="min-h-screen bg-background px-4 py-12 text-foreground sm:px-8">
        <div className="sr-only" aria-label="Fixture controls">
          {(Object.keys(RELAY_CASES) as RelayCase[]).map(candidate => (
            <button key={candidate} type="button" onClick={() => setRelayCase(candidate)}>
              Relay case {candidate}
            </button>
          ))}
        </div>

        <section
          className="mx-auto max-w-3xl space-y-8"
          aria-label="Relay disclosure fixture"
          data-relay-case={relayCase}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Session header
            </p>
            <div
              data-testid="relay-disclosure-host"
              className="mt-2 flex min-h-16 items-center rounded-xl border border-border/60 bg-card px-3 shadow-sm"
            >
              <div className="min-w-0 flex-1" data-mask-host>
                <p className="truncate text-sm font-medium">Wait for the nightly export</p>
                <p className="truncate text-xs text-muted-foreground">Sleeping · Duet computer</p>
              </div>
              <RelayStatus summary={summary} className="w-[min(34rem,72%)]" />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Job row
            </p>
            <div
              data-testid="relay-disclosure-job-host"
              className="mt-2 flex min-h-16 items-center gap-4 rounded-xl border border-border/60 bg-card px-4 shadow-sm"
            >
              <div className="min-w-0 flex-1" data-mask-host>
                <p className="truncate text-sm font-medium">Nightly customer export</p>
                <p className="truncate text-xs text-muted-foreground">Updated today</p>
              </div>
              <RelayStatus summary={summary} className="w-[min(34rem,72%)]" />
            </div>
          </div>
        </section>
      </main>
    </NextIntlClientProvider>
  )
}
