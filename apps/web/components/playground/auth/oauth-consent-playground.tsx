'use client'

import { useState } from 'react'

import type { OAuthConsentInspectResponse } from '@repo/contract'

import { OAuthConsentScreen } from '../../auth/oauth-consent-card'

const BASE_INSPECTION = {
  status: 'pending',
  client: { id: 'client_example', name: 'Example CLI' },
  redirect: { hostname: 'client.example', localhost: false },
  capabilities: ['files:read', 'files:write', 'memory', 'sessions'],
  workspaces: [{ slug: 'personal', name: 'Personal', role: 'owner' }],
  expiresAt: 2_000_000_000_000,
} satisfies OAuthConsentInspectResponse

export function OAuthConsentPlayground() {
  return (
    <>
      <OAuthConsentFixture
        fixtureId="oauth-consent-https-single-workspace"
        inspection={BASE_INSPECTION}
        initialSelectedSlug="personal"
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-https-many-workspaces"
        inspection={{
          ...BASE_INSPECTION,
          client: { id: 'client_many', name: 'Duet Desktop' },
          redirect: { hostname: 'desktop.duet.example', localhost: false },
          workspaces: [
            { slug: 'acme', name: 'Acme Inc', role: 'owner' },
            { slug: 'personal', name: 'Personal', role: 'editor' },
            { slug: 'research', name: 'Research Collective', role: 'viewer' },
          ],
        }}
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-localhost-warning"
        inspection={{
          ...BASE_INSPECTION,
          client: { id: 'client_local', name: 'Local MCP Inspector' },
          redirect: { hostname: 'localhost', localhost: true },
        }}
        initialSelectedSlug="personal"
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-no-eligible"
        inspection={{
          ...BASE_INSPECTION,
          client: { id: 'client_empty', name: 'Workspace Automation' },
          redirect: { hostname: 'automation.example', localhost: false },
          workspaces: [],
        }}
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-denied"
        inspection={{
          ...BASE_INSPECTION,
          status: 'denied',
          client: { id: 'client_denied', name: 'Example CLI' },
        }}
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-expired"
        inspection={{
          ...BASE_INSPECTION,
          status: 'expired',
          client: { id: 'client_expired', name: 'Example CLI' },
        }}
      />
      <OAuthConsentFixture
        fixtureId="oauth-consent-long-client-and-host"
        inspection={{
          ...BASE_INSPECTION,
          client: {
            id: 'client_long',
            name: 'Anomalous Materials Research Division Secure Workspace Command Line Integration',
          },
          redirect: {
            hostname: 'oauth-callback.production.eu-west.anomalous-materials-research.example',
            localhost: false,
          },
        }}
        initialSelectedSlug="personal"
      />
    </>
  )
}

function OAuthConsentFixture({
  fixtureId,
  inspection,
  initialSelectedSlug,
}: {
  fixtureId: string
  inspection: OAuthConsentInspectResponse
  initialSelectedSlug?: string
}) {
  const [selectedSlug, setSelectedSlug] = useState(initialSelectedSlug)
  return (
    <div data-fixture-id={fixtureId}>
      <OAuthConsentScreen
        inspection={inspection}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
      />
    </div>
  )
}
