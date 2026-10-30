'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import appEn from '../../messages/en/app.json'
import { AppFrameSourceProvider } from '../../spa/apps/app-frame'
import { DriveFileIconClientProvider } from '../../spa/drive/drive-file-icon'
import { DuetSpa } from '../../spa/root'
import { createDriveFileIconFixture } from './drive-file-icon-fixture'
import {
  createOnboardingJourney,
  JOURNEY_RUNS,
  type JourneyPhase,
  type JourneyRun,
} from './onboarding-journey-fixture'
import { fixtureAppFrameSource } from './spa-fixture'

/* ============================================================================
   The whole first run, without a whole new account.

   This mounts the REAL signed-in product — `DuetSpa`, its router, its
   onboarding route, its install chain — at `/`, which is where a just-registered
   browser lands. Nothing about the journey is scripted here: the fixture holds
   the workspace's onboarding stamp and the product walks itself from the root
   redirect through the wizard's steps and out into `/w/acme/agents`.

   The drawer on the left edge is the only thing in this file that is not
   production: it picks which run to replay and starts a new one. It is
   deliberately unlike anything in the product — a fixture control must never
   be mistaken for a surface under review.
   ========================================================================= */

const PHASES = [
  { id: 'setup', label: 'Setting Duet up' },
  { id: 'installing', label: 'Installing the starter agent' },
  { id: 'meeting', label: 'First conversation' },
  { id: 'drive', label: 'In the Drive' },
] as const satisfies readonly { id: JourneyPhase; label: string }[]

export function OnboardingJourneyPlayground({
  initialRun = 'fresh',
}: { initialRun?: JourneyRun } = {}) {
  const [run, setRun] = useState<JourneyRun>(initialRun)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<JourneyPhase>('setup')
  const [open, setOpen] = useState(false)
  const [driveIcons] = useState(() => createDriveFileIconFixture([]))
  const runKey = `${run}-${attempt}`
  const journey = useMemo(
    () =>
      createOnboardingJourney({
        run,
        workspaceId: `workspace_journey_${runKey}`,
        onPhase: setPhase,
      }),
    [run, runKey],
  )

  function replay(next: JourneyRun) {
    setPhase('setup')
    setRun(next)
    setAttempt(current => current + 1)
  }

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <DriveFileIconClientProvider client={driveIcons.client}>
        <AppFrameSourceProvider source={fixtureAppFrameSource}>
          <DuetSpa
            key={runKey}
            initialPath="/"
            fixtureIdentity={journey.identity}
            api={journey.api}
            trainUploads={journey.trainUploads}
          />
        </AppFrameSourceProvider>
      </DriveFileIconClientProvider>

      <div className="fixed left-0 top-1/2 z-[80] flex -translate-y-1/2 items-center">
        {open ? (
          <div className="max-w-[19rem] rounded-r-xl border border-l-0 border-foreground/20 bg-background p-4 shadow-xl">
            <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-foreground/20 pb-2.5">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Journey fixture
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Hide
              </button>
            </div>

            <ol className="mt-3 space-y-1.5">
              {PHASES.map(step => {
                const reached =
                  PHASES.findIndex(candidate => candidate.id === step.id) <=
                  PHASES.findIndex(candidate => candidate.id === phase)
                return (
                  <li
                    key={step.id}
                    className={cn(
                      'flex items-center gap-2 text-xs',
                      step.id === phase
                        ? 'font-semibold text-foreground'
                        : reached
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/50',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        reached ? 'bg-foreground' : 'bg-foreground/25',
                      )}
                    />
                    {step.label}
                  </li>
                )
              })}
            </ol>

            <div className="mt-4 space-y-1.5">
              {JOURNEY_RUNS.map(candidate => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={candidate.id === run}
                  onClick={() => replay(candidate.id)}
                  className={cn(
                    'block w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                    candidate.id === run
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-foreground/15 hover:bg-foreground/[0.05]',
                  )}
                >
                  <span className="font-semibold">{candidate.label}</span>
                  <span
                    className={cn(
                      'mt-0.5 block',
                      candidate.id === run ? 'text-background/70' : 'text-muted-foreground',
                    )}
                  >
                    {candidate.detail}
                  </span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => replay(run)}
              className="mt-3 w-full rounded-lg border border-foreground/15 px-3 py-2 text-xs font-semibold hover:bg-foreground/[0.05]"
            >
              Start this run again
            </button>

            <a
              href="/playground"
              className="mt-1.5 block w-full rounded-lg px-3 py-2 text-center text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
            >
              ← Back to playground
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-r-lg border border-l-0 border-foreground/20 bg-background px-2.5 py-5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground shadow-lg hover:text-foreground [writing-mode:vertical-rl]"
            >
              Journey
            </button>
            <a
              href="/playground"
              className="rounded-r-lg border border-l-0 border-foreground/20 bg-background px-2.5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground shadow-lg hover:text-foreground [writing-mode:vertical-rl]"
            >
              Exit
            </a>
          </div>
        )}
      </div>
    </NextIntlClientProvider>
  )
}
