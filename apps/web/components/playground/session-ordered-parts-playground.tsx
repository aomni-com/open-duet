'use client'

import { NextIntlClientProvider } from 'next-intl'
import Image from 'next/image'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import { OrderedAgentParts } from '../../spa/sessions/ordered-agent-parts'
import type { AgentMessagePart } from '../../spa/sessions/projection'

const ORDERED_PARTS: AgentMessagePart[] = [
  {
    kind: 'text',
    id: 'opening',
    text: 'I’m checking the staging evidence before I give you a release recommendation.',
  },
  {
    kind: 'reasoning',
    id: 'reasoning-evidence',
    text: 'Compare the release checklist with the latest staging evidence and verify every blocking check.',
  },
  {
    kind: 'tool',
    id: 'tool-release-report',
    toolCallId: 'read-release-report',
    name: 'read_release_report',
    status: 'complete',
    input: {
      path: '/reports/staging-release-readiness-with-a-deliberately-long-file-name.md',
      sections: ['schema', 'gateway restart', 'browser journeys'],
    },
    details: { elapsedMs: 842, source: 'workspace drive' },
    output: [
      {
        type: 'text',
        text: 'Schema, gateway restart, and browser checks passed. Production rollout owner is still unassigned.',
      },
    ],
  },
  {
    kind: 'reasoning',
    id: 'reasoning-owner',
    text: 'The technical evidence is complete. The remaining blocker is an explicit human ownership decision.',
  },
  {
    // A workspace-registered MCP server: the chip is its name, and the row
    // beside it — a tool the runner owns — has no source to name.
    kind: 'tool',
    id: 'tool-blockers',
    toolCallId: 'list-blockers',
    name: 'list_blockers',
    server: 'acme_internal',
    status: 'complete',
    input: { milestone: 'launch' },
    output: [{ type: 'text', text: 'No open blockers.' }],
  },
  {
    kind: 'tool',
    id: 'tool-rollout-owner',
    toolCallId: 'read-rollout-owner',
    name: 'read_rollout_owner',
    status: 'error',
    input: { environment: 'production' },
    output: [{ type: 'text', text: 'No production rollout owner is assigned.' }],
  },
  {
    kind: 'text',
    id: 'answer',
    text: '**Staging is ready.** Assign a production rollout owner before deployment.',
  },
]

const EDGE_PARTS: AgentMessagePart[] = [
  {
    kind: 'tool',
    id: 'tool-running',
    toolCallId: 'capture-chart',
    name: 'COMPOSIO_CAPTURE_RELEASE_CHART',
    // Duet's own catalog is a server like any other; only its label is a word.
    server: 'integrations',
    status: 'running',
    input: { width: 1600, height: 900 },
  },
  {
    kind: 'reasoning',
    id: 'reasoning-pending',
    text: 'Waiting for the final chart capture.',
    pending: true,
  },
  {
    kind: 'tool',
    id: 'tool-image',
    toolCallId: 'render-chart',
    name: 'render_release_chart',
    status: 'complete',
    output: [
      {
        type: 'image',
        mimeType: 'image/svg+xml',
        data: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIGZpbGw9IiMxMTE4MjciLz48cGF0aCBkPSJNMzAgMTQwTDkwIDk1TDE1MCAxMTBMMjEwIDUwTDI5MCA3MCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNjBlNWI1IiBzdHJva2Utd2lkdGg9IjgiLz48dGV4dCB4PSIzMCIgeT0iMzUiIGZpbGw9IiNmOGZhZmMiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE4Ij5SZWxlYXNlIHJlYWRpbmVzczwvdGV4dD48L3N2Zz4=',
      },
    ],
  },
  {
    kind: 'ask',
    id: 'ask-owner',
    questions: [{ header: 'Owner', question: 'Who should own the rollout?', options: [] }],
  },
  {
    kind: 'system',
    id: 'system-checkpoint',
    source: 'runner',
    level: 'info',
    message: 'Checkpoint saved',
  },
  {
    kind: 'lifecycle',
    id: 'lifecycle-sleep',
    type: 'sleep',
    wakeAt: Date.UTC(2026, 6, 20, 18, 0),
  },
  {
    // The one ending nobody chose: a failed terminal wears the alarm color,
    // unlike the quiet sleep divider above it.
    kind: 'lifecycle',
    id: 'lifecycle-failed',
    type: 'complete',
    status: 'failed',
    error: 'unknown: An error occurred',
  },
]

export function SessionOrderedPartsPlayground() {
  return (
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <main className="min-h-screen bg-muted/20 px-3 py-8 text-foreground sm:px-8 sm:py-12">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            <header className="px-1">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
                Session AI parts
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                Work stays nested beneath Duet
              </h1>
            </header>

            <PartFixture title="Mixed source order" parts={ORDERED_PARTS} />
            <PartFixture title="Pending, image, ask, and lifecycle" parts={EDGE_PARTS} />
          </div>
        </main>
      </NextIntlClientProvider>
    </MemoryRouter>
  )
}

function PartFixture({ title, parts }: { title: string; parts: AgentMessagePart[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
      <div className="flex items-center gap-3 bg-muted px-4 py-3 md:px-6">
        <Image
          src="/icons/duet-avatar.png"
          alt=""
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-full object-cover ring-1 ring-border/70"
        />
        <div>
          <p className="text-sm font-medium">Duet</p>
          <p className="text-xs text-muted-foreground">{title}</p>
        </div>
      </div>
      <div className="px-4 py-3 pl-14 md:px-6 md:pl-[4.5rem]">
        <OrderedAgentParts
          agentName="Duet"
          parts={parts}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </div>
    </section>
  )
}
