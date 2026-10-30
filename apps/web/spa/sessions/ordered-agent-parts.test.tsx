import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import { OrderedAgentParts } from './ordered-agent-parts'
import type { AgentMessagePart } from './projection'

const mixedParts: AgentMessagePart[] = [
  { kind: 'text', id: 'opening', text: 'I checked the release.' },
  { kind: 'reasoning', id: 'reasoning-one', text: 'Compare the evidence.' },
  {
    kind: 'tool',
    id: 'tool-complete',
    toolCallId: 'read-release',
    name: 'read_release_report',
    status: 'complete',
    input: { path: '/reports/release.md' },
    output: [{ type: 'text', text: 'All checks passed.' }],
  },
  { kind: 'reasoning', id: 'reasoning-two', text: 'One owner remains.' },
  {
    kind: 'tool',
    id: 'tool-error',
    toolCallId: 'read-owner',
    name: 'read_rollout_owner',
    status: 'error',
    output: [{ type: 'text', text: 'Owner is missing.' }],
  },
  { kind: 'text', id: 'answer', text: 'Staging is ready; assign the rollout owner.' },
]

test('renders projected AI parts in source order without creating message rows', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={mixedParts}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  const partIds = [...html.matchAll(/data-agent-part-id="([^"]+)"/g)].map(match => match[1])
  expect(partIds).toEqual([
    'opening',
    'reasoning-one',
    'tool-complete',
    'reasoning-two',
    'tool-error',
    'answer',
  ])
  expect(html).not.toContain('<article')
  expect(html.match(/<details/g)).toHaveLength(5)
  expect(html).not.toContain('open=""')
  expect(html).toContain('Staging is ready; assign the rollout owner.')
})

test('auto-expands a single activity part while keeping multi-part traces collapsed', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'tool',
              id: 'only-tool',
              toolCallId: 'only-call',
              name: 'read_report',
              status: 'complete',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html.match(/<details/g)).toHaveLength(2)
  expect(html.match(/<details open=""/g)).toHaveLength(1)
})

test('pending text leaves working status to the composer', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'text',
              id: 'streaming-answer',
              text: 'The answer is still arriving.',
              pending: true,
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('The answer is still arriving.')
  expect(html).not.toContain('role="status"')
  expect(html).not.toContain(appEn.duetApp.sessionProduct.working)
})

test('keeps pending, image, ask, system, and lifecycle states inside the part owner', () => {
  const edgeParts: AgentMessagePart[] = [
    { kind: 'reasoning', id: 'pending', text: 'Still checking.', pending: true },
    {
      kind: 'tool',
      id: 'image-tool',
      toolCallId: 'image-call',
      name: 'render_chart',
      status: 'complete',
      output: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
    },
    {
      kind: 'ask',
      id: 'ask',
      questions: [{ header: 'Owner', question: 'Who owns rollout?', options: [] }],
    },
    { kind: 'system', id: 'system', source: 'runner', level: 'info', message: 'Saved' },
    { kind: 'lifecycle', id: 'sleep', type: 'sleep', wakeAt: 0 },
  ]

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={edgeParts}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // Reasoning stays collapsed even while streaming; the trace summary and its
  // line preview keep the part legible before the full body is expanded.
  expect(html).not.toMatch(/data-agent-part-id="pending"[^>]*open=""/)
  expect(html.split('Still checking.')).toHaveLength(3)
  expect(html).not.toContain('src="data:image/png;base64,aW1hZ2U="')
  expect(html).toContain('Who owns rollout?')
  expect(html).toContain('Saved')
  expect(html).toContain('Sleeping')
  expect(html).not.toContain('<article')
})

// The control plane ends a turn itself when the VM could not — a stop the
// runner never took, a paused workspace — and stamps the marker with an
// operator code. The reader gets the sentence, not the code.
test('reads a control-plane interrupt reason as prose', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'lifecycle',
              id: 'stopped',
              type: 'interrupted',
              error: 'interrupt_undeliverable',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('Interrupted')
  expect(html).toContain('the agent had already stopped')
  expect(html).not.toContain('interrupt_undeliverable')
})

test('keeps an unrecognized interrupt reason visible rather than swallowing it', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            { kind: 'lifecycle', id: 'stopped', type: 'interrupted', error: 'disk quota exceeded' },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('disk quota exceeded')
})

test('tool rows use a spinner while running and a check when complete', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            ...mixedParts,
            {
              kind: 'tool',
              id: 'tool-running',
              toolCallId: 'capture-chart',
              name: 'capture_chart',
              status: 'running',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // Status stays an icon-only affordance; running uses the same compact footprint
  // as its settled check so the row does not jump when the call completes.
  expect(html).toContain('aria-label="complete"')
  expect(html).toContain('aria-label="error"')
  expect(html).toContain('aria-label="running"')
  expect(html).not.toContain('>running<')
  expect(html).not.toContain('>complete<')
  expect(html).not.toContain('>error<')
  // A failed tool call is signal the agent works around, not an alarm: no
  // destructive tint and no warning glyph anywhere in the rows.
  expect(html).not.toContain('text-destructive')
})

test('agent work shows a spinner while reasoning or a tool is still running', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            { kind: 'reasoning', id: 'pending-reasoning', text: 'Still checking.', pending: true },
            {
              kind: 'tool',
              id: 'settled-tool',
              toolCallId: 'read-report',
              name: 'read_report',
              status: 'complete',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  const activitySummary = html.match(
    /data-agent-activity="[^"]+"[\s\S]*?<summary[\s\S]*?<\/summary>/,
  )?.[0]
  expect(activitySummary).toContain('aria-label="working"')

  const runningToolHtml = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'tool',
              id: 'running-tool',
              toolCallId: 'read-report',
              name: 'read_report',
              status: 'running',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  const runningToolSummary = runningToolHtml.match(
    /data-agent-activity="[^"]+"[\s\S]*?<summary[\s\S]*?<\/summary>/,
  )?.[0]
  expect(runningToolSummary).toContain('aria-label="working"')
})

// D19: the server that exposed a tool is its own chip, so the row names the
// tool and its source separately instead of printing the runner's joined
// string. Applied uniformly — Duet's own integration catalog is a server like
// any other, and only its label is localized.
test('an MCP tool wears its server as a chip beside the tool name', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'tool',
              id: 'catalog-tool',
              toolCallId: 'call-catalog',
              name: 'LINEAR_CREATE_ISSUE',
              server: 'integrations',
              status: 'complete',
            },
            {
              kind: 'tool',
              id: 'custom-tool',
              toolCallId: 'call-custom',
              name: 'search__orders',
              server: 'acme_internal',
              status: 'running',
            },
            {
              kind: 'tool',
              id: 'builtin-tool',
              toolCallId: 'call-builtin',
              name: 'read_file',
              status: 'complete',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  const chips = [...html.matchAll(/data-tool-server="([^"]*)"[^>]*>([^<]*)</g)].map(match => [
    match[1],
    match[2],
  ])
  expect(chips).toEqual([
    ['integrations', appEn.duetApp.sessionProduct.toolServerIntegrations],
    ['acme_internal', 'acme_internal'],
  ])
  // The runner's joined name never reaches the reader.
  expect(html).not.toContain('integrations__')
  expect(html).not.toContain('acme_internal__')
  // A tool the runner owns has no source to name, so it grows no chip.
  expect(html).toContain('read_file')
})

// A runner's error is free text and can arrive as one unbroken 3,000-character
// blob — a provider's raw JSON did exactly that, and the whole chat pane
// A failed terminal is the one ending nobody chose: the turn died and its
// work is gone unless someone acts. Unlike a tool error (routed around) or a
// user interrupt (chosen), it earns the product's alarm color — a muted
// divider below a folded tool card reads as "the transcript just stops".
test('a failed terminal is a real error affordance, not a divider', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'lifecycle',
              id: 'failed',
              type: 'complete',
              status: 'failed',
              error: 'unknown: An error occurred',
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('text-destructive')
  expect(html).toContain('role="alert"')
  expect(html).toContain('Failed')
  expect(html).toContain('unknown: An error occurred')
})

// The alarm stays reserved for failure: endings someone chose (stop, sleep)
// keep the quiet divider.
test('interrupted and sleep terminals stay quiet dividers', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            { kind: 'lifecycle', id: 'stopped', type: 'interrupted', error: 'user interrupted' },
            { kind: 'lifecycle', id: 'sleep', type: 'sleep', wakeAt: 0 },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).not.toContain('text-destructive')
  expect(html).not.toContain('role="alert"')
})

// scrolled sideways because a flex child defaults to `min-width: auto` and so
// refuses to shrink below its own content. The row has to be allowed to shrink
// AND to break the string.
test('an unbreakable error cannot push the transcript sideways', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          agentName="Duet"
          parts={[
            {
              kind: 'lifecycle',
              id: 'failed',
              type: 'complete',
              status: 'failed',
              error: `{"error":{"message":"${'x'.repeat(3000)}"}}`,
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // The blob lives in the alert's text span; that flex child must be allowed
  // to shrink below its content AND to break the string.
  const row = html.match(/<span class="([^"]*)"><span class="font-medium">/)?.[1] ?? ''
  expect(row).toContain('min-w-0')
  expect(row).toContain('break-words')
})

test('closed tools do not serialize or mount stored payloads', () => {
  let serialized = 0
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <OrderedAgentParts
        agentName="Duet"
        parts={[
          {
            kind: 'tool',
            id: 'large-tool',
            toolCallId: 'large-tool',
            name: 'read_file',
            status: 'complete',
            input: {
              toJSON: () => {
                serialized++
                return { path: 'private-input' }
              },
            },
            details: {
              toJSON: () => {
                serialized++
                return 'private-details'
              },
            },
            output: [{ type: 'text', text: 'private-output' }],
          },
        ]}
        cwd={undefined}
        workspaceSlug="acme"
        fileUrl={() => 'about:blank'}
      />
    </NextIntlClientProvider>,
  )
  expect(serialized).toBe(0)
  expect(html).toContain('read_file')
  expect(html).not.toContain('private-')
  expect(html).not.toContain('<pre')
})

/* A question is asked by a particular agent, and the banner says which. It used
   to say "Duet" whatever agent you were talking to. It also wears the ask tone
   every "needs you" mark wears, not the amber that now means unread. */
test('a question names the agent that asked it, in the ask tone', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <OrderedAgentParts
          parts={[
            {
              kind: 'ask',
              id: 'ask',
              questions: [{ header: 'Owner', question: 'Who owns rollout?', options: [] }],
            },
          ]}
          cwd={undefined}
          workspaceSlug="acme"
          fileUrl={() => 'about:blank'}
          agentName="Research"
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )
  expect(html).toContain('Research needs your input')
  expect(html).not.toContain('Duet needs your input')
  expect(html).toContain('text-ask')
  expect(html).not.toContain('amber')
})
