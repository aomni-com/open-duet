'use client'

import { NextIntlClientProvider } from 'next-intl'

import { DESKTOP_SCREEN, type DesktopOwnerActivity, type DesktopPhase } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { DesktopFrameSourceProvider, DesktopPane } from '../../spa/desktop/desktop-pane'

export function DesktopPanePlayground({
  state,
}: {
  state: 'connecting' | 'live' | 'driving' | 'unhealthy'
}) {
  const phase: DesktopPhase = state === 'connecting' ? 'starting' : 'ready'
  const owners: DesktopOwnerActivity[] =
    state === 'driving'
      ? [
          {
            owner: { kind: 'agent', agentId: 'researcher' },
            agentSlug: 'researcher',
            agentName: 'Researcher',
            phase: 'active',
            focused: true,
            liveBatchCount: 1,
            batchTabCount: 2,
            discardedBatchTabCount: 0,
            lastActiveAt: 1_786_533_905_000,
          },
          {
            owner: { kind: 'agent', agentId: 'writer' },
            agentSlug: 'writer',
            agentName: 'Writer',
            phase: 'cooling',
            focused: false,
            liveBatchCount: 1,
            batchTabCount: 1,
            discardedBatchTabCount: 0,
            lastActiveAt: 1_786_533_900_000,
          },
        ]
      : []

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <main className="min-h-screen bg-[#f2f4f7] p-8">
        <div className="mx-auto flex h-[760px] max-w-[1320px] flex-col rounded-[28px] border border-black/10 bg-white p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between px-1">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Workspace
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">Desktop</h1>
            </div>
            <span className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground">
              1440 × 900
            </span>
          </div>
          <DesktopFrameSourceProvider source={() => '/playground/desktop-frame'}>
            <DesktopPane
              phase={phase}
              entryUrl={phase === 'ready' ? 'https://fixture.invalid/desktop' : null}
              owners={owners}
              screen={DESKTOP_SCREEN}
              refusal={state === 'unhealthy' ? 'unhealthy' : undefined}
            />
          </DesktopFrameSourceProvider>
        </div>
      </main>
    </NextIntlClientProvider>
  )
}
