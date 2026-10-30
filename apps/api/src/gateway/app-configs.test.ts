import { expect, test } from 'bun:test'

import type { GatewayAppConfig } from '@repo/contract'

import { composeVmSyncResponse } from '../routes/vm'
import { withPublicAppUrls } from './app-configs'

test('public app configs receive the configured edge URL while private configs receive none', () => {
  const configs: GatewayAppConfig[] = [
    {
      appId: 'public-id',
      slug: 'status',
      command: 'bun run start',
      port: 4_173,
      anchorPath: 'apps/status',
      apiScopes: [],
      visibility: 'public',
    },
    {
      appId: 'private-id',
      slug: 'notes',
      command: 'bun run start',
      port: 4_174,
      anchorPath: 'apps/notes',
      apiScopes: [],
      visibility: 'folder',
      canonicalUrl: 'https://stale.invalid/',
    },
  ]

  expect(
    withPublicAppUrls(configs, {
      workspaceSlug: 'acme',
      edgeHost: 'edge-staging.duet.so',
    }),
  ).toEqual([
    { ...configs[0]!, canonicalUrl: 'https://status--acme.edge-staging.duet.so/' },
    {
      appId: 'private-id',
      slug: 'notes',
      command: 'bun run start',
      port: 4_174,
      anchorPath: 'apps/notes',
      apiScopes: [],
      visibility: 'folder',
    },
  ])
})

test('public agent links switch to the active custom domain while private apps advertise no URL', () => {
  const config: GatewayAppConfig = {
    appId: 'app-1',
    slug: 'tools',
    command: 'bun run start',
    port: 4173,
    anchorPath: 'apps/tools',
    apiScopes: [],
    visibility: 'public',
    customDomain: { hostname: 'tools.example.com', status: 'active' },
  }
  expect(
    withPublicAppUrls([config], { workspaceSlug: 'acme', edgeHost: 'edge-staging.duet.so' }),
  ).toEqual([{ ...config, canonicalUrl: 'https://tools.example.com/' }])
  expect(
    withPublicAppUrls([{ ...config, visibility: 'folder' }], {
      workspaceSlug: 'acme',
      edgeHost: 'edge-staging.duet.so',
    }),
  ).toEqual([{ ...config, visibility: 'folder' }])
})

test('VM sync emits the same enriched configs and workspace slug', () => {
  const apps: GatewayAppConfig[] = [
    {
      appId: 'public-id',
      slug: 'status',
      command: 'bun run start',
      port: 4_173,
      anchorPath: 'apps/status',
      apiScopes: [],
      visibility: 'public',
    },
    {
      appId: 'private-id',
      slug: 'notes',
      command: 'bun run start',
      port: 4_174,
      anchorPath: 'apps/notes',
      apiScopes: [],
      visibility: 'folder',
    },
  ]
  const enriched = withPublicAppUrls(apps, {
    workspaceSlug: 'acme',
    edgeHost: 'edge-staging.duet.so',
  })

  expect(
    composeVmSyncResponse({
      pollAfterMs: 5_000,
      workspaceSlug: 'acme',
      edgeHost: 'edge-staging.duet.so',
      anchors: [],
      mirrorMachineIds: [],
      // Passed through verbatim — the roster gets no URL enrichment, and the
      // synthetic root member rides beside the registered rows.
      agents: [
        { kind: 'root', slug: 'root', name: 'Duet' },
        {
          kind: 'agent',
          agentId: 'agent-1',
          anchorId: 'anchor-1',
          anchorPath: 'agents/research',
          slug: 'research',
          name: 'Research',
        },
      ],
      apps,
      shareSync: { shares: [] },
      updatesPaused: true,
      quiesce: false,
      runtimeRelease: null,
      modelGatewayUrl: null,
      skills: { hash: 'fixture', url: 'https://ctl.test/v1/vm/skills/fixture' },
    }),
  ).toMatchObject({
    workspaceSlug: 'acme',
    apps: enriched,
    agents: [
      { kind: 'root', slug: 'root', name: 'Duet' },
      { kind: 'agent', slug: 'research', name: 'Research' },
    ],
  })
})
