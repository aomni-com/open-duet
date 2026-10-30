import {
  groupAppsByAgent,
  type AgentResolutionCandidate,
  type GatewayAppConfig,
} from '@repo/contract'

import { sanitizePromptLabel } from './prompt-text'

const MAX_APP_ROWS = 30
const MAX_APP_NAME_LENGTH = 64

export function yourAppsPrompt(args: {
  apps: readonly GatewayAppConfig[]
  scope: { kind: 'agent'; agentId: string } | { kind: 'root' }
  candidates: readonly AgentResolutionCandidate[]
  workspaceSlug: string
}): string {
  const groups = groupAppsByAgent(args.candidates, args.apps)
  const scopedApps =
    args.scope.kind === 'root' ? groups.root : (groups.byAgentId.get(args.scope.agentId) ?? [])
  const sortedApps = [...scopedApps].sort((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
  )
  const visibleApps = sortedApps.slice(0, MAX_APP_ROWS)
  const remainder = sortedApps.length - visibleApps.length

  return [
    '# Your apps',
    '',
    "The apps in this session's scope, as of this turn.",
    '',
    ...(visibleApps.length === 0
      ? ['No apps are registered in this session scope yet.']
      : visibleApps.map(renderAppRow)),
    ...(remainder === 0
      ? []
      : [
          '',
          `${remainder} more ${remainder === 1 ? 'app is' : 'apps are'} available from \`GET /v1/ws/${args.workspaceSlug}/apps\`.`,
        ]),
    '',
    '## Call an app',
    '',
    'These apps are running services on this VM. Call one at its API address above —',
    'nothing else is needed to reach it.',
    '',
    "Read an app's `README.md` before calling its API or changing its code — it says",
    'what the app is for and what its API accepts. If you change an app, update its',
    'README in the same turn.',
    '',
    "After changing an app's data, tell the user what changed and point them to the",
    'app open beside the conversation.',
    '',
    '## Move this session into an app',
    '',
    'When building, editing, or demonstrating an app, move the session there as one of your first actions:',
    '',
    '```bash',
    'curl -sS -X POST \\',
    `  "$DUET_API_URL/v1/ws/${args.workspaceSlug}/agent/sessions/$DUET_SESSION_ID/cwd" \\`,
    '  -H "Authorization: Bearer $DUET_API_KEY" \\',
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"cwd":"projects/example"}'`,
    '```',
    '',
    'Use the app directory from the list above as `cwd`. The user sees the app immediately; your own working directory updates at your next turn.',
    '',
    'Building and broken apps are safe to show: the gateway serves its own building page while the app is unavailable.',
    '',
    'For the rest of this turn, show files by their full drive path: the reader already resolves a plain path against the new folder.',
    '',
  ].join('\n')
}

function renderAppRow(app: GatewayAppConfig): string {
  const name = sanitizePromptLabel(app.name ?? app.slug, {
    fallback: 'App',
    maxLength: MAX_APP_NAME_LENGTH,
  })
  const visibility =
    app.visibility === 'public' && app.canonicalUrl !== undefined
      ? `public (${app.canonicalUrl})`
      : 'private'
  return `- **${name}** (\`${app.slug}\`) — \`${app.anchorPath}\` — ${visibility} — API \`http://127.0.0.1:${app.port}\``
}
