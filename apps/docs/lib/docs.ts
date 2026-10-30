import type { PublicApiEndpointCategory } from '@repo/contract'

export interface DocsRoute {
  readonly href: `/${string}` | '/'
  readonly title: string
  readonly description: string
  readonly visualId: `docs-${string}`
}

export interface DocsSection {
  readonly title: string
  readonly routes: readonly DocsRoute[]
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    title: 'Start here',
    routes: [
      {
        href: '/',
        title: 'Overview',
        description: 'The API documentation map.',
        visualId: 'docs-home',
      },
      {
        href: '/getting-started',
        title: 'Getting started',
        description: 'Make a first authenticated request.',
        visualId: 'docs-getting-started',
      },
      {
        href: '/api-keys',
        title: 'API keys and scopes',
        description: 'Human identity, live workspace access and delegated grants.',
        visualId: 'docs-api-keys',
      },
      {
        href: '/workspaces',
        title: 'Workspace selection',
        description: 'Keep credentials and resource paths aligned.',
        visualId: 'docs-workspaces',
      },
    ],
  },
  {
    title: 'Protocol',
    routes: [
      {
        href: '/errors',
        title: 'Errors',
        description: 'Handle stable failure categories.',
        visualId: 'docs-errors',
      },
      {
        href: '/pagination',
        title: 'Pagination',
        description: 'Traverse changing collections safely.',
        visualId: 'docs-pagination',
      },
      {
        href: '/reliability',
        title: 'Idempotency and rate limits',
        description: 'Retry without duplicating effects.',
        visualId: 'docs-reliability',
      },
      {
        href: '/events',
        title: 'SSE and resume',
        description: 'Reconnect ordered event streams.',
        visualId: 'docs-events',
      },
    ],
  },
  {
    title: 'Resources',
    routes: [
      {
        href: '/sessions',
        title: 'Sessions',
        description: 'Drive long-running agent work.',
        visualId: 'docs-sessions',
      },
      {
        href: '/desktop',
        title: 'Desktop',
        description: 'Embed and focus the shared workspace desktop.',
        visualId: 'docs-desktop',
      },
      {
        href: '/apps',
        title: 'Apps',
        description: 'Register workspace-served applications.',
        visualId: 'docs-apps',
      },
      {
        href: '/agents',
        title: 'Agents',
        description: 'Register folders that shape their sessions.',
        visualId: 'docs-agents',
      },
      {
        href: '/files',
        title: 'Files',
        description: 'Read and write workspace content.',
        visualId: 'docs-files',
      },
      {
        href: '/file-activity',
        title: 'File activity',
        description: 'Query who read and wrote workspace files.',
        visualId: 'docs-file-activity',
      },
      {
        href: '/train',
        title: 'Train',
        description: 'Ingest bounded memory corpora.',
        visualId: 'docs-train',
      },
      {
        href: '/integrations',
        title: 'Integrations',
        description: 'Invoke connected provider actions.',
        visualId: 'docs-integrations',
      },
      {
        href: '/shares-publishes',
        title: 'Shares and publishes',
        description: 'Choose private collaboration or public output.',
        visualId: 'docs-shares-publishes',
      },
      {
        href: '/mirror-devices',
        title: 'Mirror devices',
        description: 'Mirror a whole workspace drive to a device.',
        visualId: 'docs-mirror-devices',
      },
      {
        href: '/sync',
        title: 'Sync to your Mac',
        description: 'Install the daemon that mirrors your workspaces.',
        visualId: 'docs-sync',
      },
      {
        href: '/billing',
        title: 'Billing boundaries',
        description: 'Understand payer-owned limits and usage.',
        visualId: 'docs-billing',
      },
      {
        href: '/services',
        title: 'Services',
        description: 'Discover and call catalogued third-party APIs.',
        visualId: 'docs-services',
      },
      {
        href: '/device-flow',
        title: 'Device flow',
        description: 'Authorize tools without embedding credentials.',
        visualId: 'docs-device-flow',
      },
    ],
  },
  {
    title: 'Reference',
    routes: [
      {
        href: '/reference',
        title: 'Endpoint reference',
        description: 'Contract-owned methods, paths, scopes, and schemas.',
        visualId: 'docs-reference',
      },
    ],
  },
]

export const DOCS_ROUTES = DOCS_SECTIONS.flatMap(section => section.routes)

export function docsCanonicalUrl(href: DocsRoute['href']): string {
  const pathname = href === '/' ? href : `${href}/`
  return new URL(pathname, 'https://docs.duet.so').toString()
}

export const ENDPOINT_CATEGORY_ROUTES = new Map<PublicApiEndpointCategory, DocsRoute['href']>([
  ['identity', '/workspaces'],
  ['backups', '/workspaces'],
  ['sessions', '/sessions'],
  ['desktop', '/desktop'],
  ['apps', '/apps'],
  ['agents', '/agents'],
  ['files', '/files'],
  ['file-activity', '/file-activity'],
  ['train', '/train'],
  ['integrations', '/integrations'],
  ['shares', '/shares-publishes'],
  ['publishes', '/shares-publishes'],
  ['sync', '/mirror-devices'],
  ['billing', '/billing'],
  ['services', '/services'],
  ['device', '/device-flow'],
])
