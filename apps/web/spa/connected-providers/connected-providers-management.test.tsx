import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import messages from '../../messages/en/app.json'
import type { ConnectedProviderPresentation } from './connected-provider-presentation'
import { ConnectedProvidersManagement } from './connected-providers-management'

const ALL_STATE_FIXTURES = [
  { provider: 'openai-codex', state: 'disconnected' },
  { provider: 'github-copilot', state: 'connecting' },
  {
    provider: 'openai-codex',
    state: 'awaiting_code',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://provider.example.test/device',
  },
  {
    provider: 'github-copilot',
    state: 'connected',
    connectedByLabel: 'David',
    canDisconnect: true,
  },
  { provider: 'openai-codex', state: 'plan_ineligible', canDisconnect: false },
  { provider: 'github-copilot', state: 'reconnect_needed', canDisconnect: true },
  { provider: 'openai-codex', state: 'failed' },
  { provider: 'github-copilot', state: 'disconnecting' },
] satisfies ConnectedProviderPresentation[]

test('renders a disconnected provider from props with a connect affordance', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      <ConnectedProvidersManagement
        providers={[{ provider: 'openai-codex', state: 'disconnected' }]}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('OpenAI Codex')
  expect(html).toContain('Not connected')
  expect(html).toContain('Connect')
})

test('renders every provider state from props and honors server disconnect authorization', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      <ConnectedProvidersManagement
        providers={ALL_STATE_FIXTURES}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
    </NextIntlClientProvider>,
  )

  for (const copy of [
    'Not connected',
    'Connecting…',
    'Waiting for approval',
    'Connected by David',
    'This account’s plan is not eligible',
    'Reconnect needed',
    'Connection failed',
    'Disconnecting…',
  ]) {
    expect(html).toContain(copy)
  }
  expect(html).toContain('ABCD-EFGH')
  expect(html).toContain('href="https://provider.example.test/device"')
  for (const provider of ALL_STATE_FIXTURES) {
    if (!('canDisconnect' in provider)) continue
    const row = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
        <ConnectedProvidersManagement
          providers={[provider]}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      </NextIntlClientProvider>,
    )
    expect(row.includes('>Disconnect</button>')).toBe(provider.canDisconnect === true)
  }
  expect(html.match(/Connecting…/g)).toHaveLength(1)
  expect(html.match(/Disconnecting…/g)).toHaveLength(1)
})
