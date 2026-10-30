'use client'

import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  ClockIcon,
  HardDrivesIcon,
  PlusIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'

import {
  MAX_MCP_SERVERS_PER_WORKSPACE,
  McpServerNameSchema,
  McpServerUrlSchema,
  type AddMcpServerRequest,
  type McpServer,
  type McpServerErrorCode,
  type McpServerProbe,
  type McpServerProbeRequest,
} from '@repo/contract'
import { Button, buttonVariants } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { Input } from '@repo/ui/components/shadcn/input'
import { cn } from '@repo/ui/lib/utils'

import {
  WorkspaceEmptyState,
  WorkspacePanel,
  WorkspacePanelHeader,
} from '../../drive/workspace-page'
import {
  IntegrationAgentAccessEditor,
  type IntegrationAgentOption,
} from './integration-agent-access'

/**
 * The custom MCP servers a workspace attaches for itself, beside the connected
 * apps rather than instead of them.
 *
 * Presentational, like the surface that hosts it: every answer arrives as a
 * prop, including the probe, so the playground can freeze a server mid-check
 * and the route stays the only thing that talks to the API.
 *
 * There is deliberately no warning copy about where a tool call's data goes and
 * no role or tier gate. Adding the server is the consent, and any member may
 * add one exactly as any member may connect an app.
 */

/**
 * Four bytes to a token is the ratio the probe's byte measurement is meant to
 * be read through. It is an estimate on both sides — the row says so — and the
 * point of the number is comparison between servers, not billing.
 */
const BYTES_PER_TOKEN = 4

export type McpServersPanelProps = {
  state: 'loading' | 'error' | 'ready'
  refreshFailed?: boolean
  servers: McpServer[]
  agents: IntegrationAgentOption[]
  /** Injected so a fixture's health lines are byte-stable in a screenshot. */
  now: number
  /** The row a submitted add is still waiting on, held outside the list: the
      contract has no state that means "not written yet", and inventing one on
      the client would put a second answer to "what state is this server in"
      beside the server's own. */
  pendingAdd?: { name: string; url: string }
  addError?: boolean
  removing?: string
  /** The server whose consent leg is in flight, by name. */
  connecting?: string
  /** A consent that never reached a consent page, with the route's own code:
      the click has to say something, and the health line below the row is
      about the server, not about the attempt that just failed. */
  connectError?: { name: string; code?: string }
  pendingAgentPolicies?: ReadonlySet<string>
  failedAgentPolicies?: ReadonlySet<string>
  onProbe(input: McpServerProbeRequest, signal: AbortSignal): Promise<McpServerProbe>
  onAdd(input: AddMcpServerRequest): void
  onConnect(server: McpServer): void
  onRemove(server: McpServer): void
  onSetAgentPolicy(server: McpServer, allowedAgentIds: string[] | undefined): void
  onRetry(): void
}

export function McpServersPanel({
  state,
  refreshFailed,
  servers,
  agents,
  now,
  pendingAdd,
  addError,
  removing,
  connecting,
  connectError,
  pendingAgentPolicies,
  failedAgentPolicies,
  onProbe,
  onAdd,
  onConnect,
  onRemove,
  onSetAgentPolicy,
  onRetry,
}: McpServersPanelProps) {
  const t = useTranslations('duetIntegrations.mcpServers')
  const tShared = useTranslations('duetIntegrations')
  const [adding, setAdding] = useState(false)
  const rows = servers.length + (pendingAdd === undefined ? 0 : 1)

  return (
    <WorkspacePanel data-mcp-servers-panel="">
      <WorkspacePanelHeader
        title={t('title')}
        description={state === 'ready' ? t('count', { count: rows }) : t('description')}
        leading={<HardDrivesIcon className="size-4" weight="duotone" />}
        trailing={
          state === 'ready' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAdding(true)}
              disabled={servers.length >= MAX_MCP_SERVERS_PER_WORKSPACE}
            >
              <PlusIcon className="size-3.5" />
              {t('add')}
            </Button>
          ) : undefined
        }
      />
      {addError ? (
        <p
          role="alert"
          className="border-b border-destructive/20 bg-destructive/5 px-5 py-2.5 text-xs font-medium text-destructive"
        >
          {t('addError')}
        </p>
      ) : null}
      {connectError ? (
        <p
          role="alert"
          className="border-b border-destructive/20 bg-destructive/5 px-5 py-2.5 text-xs font-medium text-destructive"
        >
          {t(connectErrorKey(connectError.code), { name: connectError.name })}
        </p>
      ) : null}
      {state === 'ready' && refreshFailed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-2.5 text-xs font-medium text-destructive"
        >
          <span>{t('refreshError')}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tShared('retry')}
          </Button>
        </div>
      ) : null}
      {state === 'loading' ? (
        <div className="flex min-h-32 items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground">
          <CircleNotchIcon className="size-4 animate-spin" aria-hidden />
          {t('loading')}
        </div>
      ) : state === 'error' ? (
        /* Scoped to this panel on purpose: a workspace's own servers and the
           provider catalog fail independently, and one outage must not blank
           the other's rows. */
        <WorkspaceEmptyState
          className="min-h-48"
          tone="destructive"
          icon={<WarningCircleIcon />}
          title={t('loadErrorTitle')}
          body={t('loadErrorBody')}
          action={
            <button type="button" onClick={onRetry} className={buttonVariants({ size: 'sm' })}>
              {tShared('retry')}
            </button>
          }
        />
      ) : rows === 0 ? (
        <div className="px-5 py-10 text-center">
          <HardDrivesIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
        </div>
      ) : (
        /* One bordered block per server rather than a divided list. Each server
           carries two full-width sub-strips of its own, and with hairlines
           between everything two independent reviewers could not tell which
           strip belonged to which server. */
        <div className="space-y-3 p-3">
          {servers.map(server => (
            <McpServerRow
              key={server.name}
              server={server}
              agents={agents}
              now={now}
              removing={removing === server.name}
              connecting={connecting}
              pendingPolicy={pendingAgentPolicies?.has(server.name)}
              failedPolicy={failedAgentPolicies?.has(server.name)}
              onConnect={() => onConnect(server)}
              onRemove={() => onRemove(server)}
              onSetAgentPolicy={allowedAgentIds => onSetAgentPolicy(server, allowedAgentIds)}
            />
          ))}
          {pendingAdd ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-4 py-3.5">
              <ServerMark />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{pendingAdd.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {displayOrigin(pendingAdd.url)}
                </span>
              </div>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleNotchIcon className="size-3.5 animate-spin" aria-hidden />
                {t('adding', { name: pendingAdd.name })}
              </span>
            </div>
          ) : null}
        </div>
      )}
      {adding ? (
        <AddMcpServerDialog
          existingNames={servers.map(server => server.name)}
          serverCount={servers.length}
          onProbe={onProbe}
          onCancel={() => setAdding(false)}
          onAdd={input => {
            setAdding(false)
            onAdd(input)
          }}
        />
      ) : null}
    </WorkspacePanel>
  )
}

function McpServerRow({
  server,
  agents,
  now,
  removing,
  connecting,
  pendingPolicy,
  failedPolicy,
  onConnect,
  onRemove,
  onSetAgentPolicy,
}: {
  server: McpServer
  agents: IntegrationAgentOption[]
  now: number
  removing?: boolean
  connecting?: string
  pendingPolicy?: boolean
  failedPolicy?: boolean
  onConnect(): void
  onRemove(): void
  onSetAgentPolicy(allowedAgentIds: string[] | undefined): void
}) {
  const t = useTranslations('duetIntegrations.mcpServers')
  /* The two states a human can act on, and the only two: a server registered
     but never consented to, and one whose credential has stopped being
     accepted. Both are one click from working again, so the row carries the
     remedy rather than only the way out. The word is the whole explanation —
     the health band directly below already says what is wrong, and repeating
     it beside the button would be the second answer to one question. */
  const consent =
    server.state === 'needs_auth'
      ? 'connect'
      : server.state === 'reauth_required'
        ? 'reconnect'
        : undefined
  return (
    <div className="overflow-hidden rounded-lg border border-border/70">
      <div className="flex flex-wrap items-center gap-x-3 px-4 py-3.5">
        <ServerMark />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{server.label}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {displayOrigin(server.url)}
          </span>
          {/* The kind rides the metadata line rather than the right edge, where
              the connected-apps panel above puts its status pills. Same column,
              different meaning — health here is the health line's job — and a
              reviewer read the right-edge version as a status. */}
          <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 px-1.5 py-0.5 font-medium">
              {t(`authKind.${server.authKind}`)}
            </span>
            <ToolCost server={server} />
          </span>
          <DroppedTools server={server} />
        </div>
        {/* Beside the identity from `sm` up, on its own right-aligned line
            below it — indented past the mark, exactly as the connected-apps
            rows above do it. A remedy, a removal, and the agent-access
            dropdown are three controls, and `shrink-0` buttons on a
            phone-width identity line left the server's own name and address
            as ellipses; `flex-wrap` lets that trio spill onto a second line
            of its own rather than clip or overflow the row.
            The negative margin is what makes the wrapped line legible: the
            44px touch target puts 12px of air above its own label, which left
            the controls equidistant between the identity and the status band,
            and an unprimed reader then read "Reconnect" as the red band's
            remedy and "Remove" as something a green band was inviting. */}
        <div className="-mt-1.5 ml-13 flex w-full flex-wrap items-center justify-end gap-1 sm:ml-0 sm:mt-0 sm:w-auto">
          {consent === undefined ? null : (
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting !== undefined}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'min-h-11 shrink-0 text-brand hover:bg-brand/10 hover:text-brand sm:min-h-0',
              )}
            >
              {connecting === server.name ? t(`${consent}ing`) : t(consent)}
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            disabled={removing || server.state === 'disconnecting'}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'min-h-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive sm:min-h-0',
            )}
          >
            {removing ? t('removing') : t('remove')}
          </button>
          <IntegrationAgentAccessEditor
            subject={server.name}
            subjectKind="mcpServer"
            allowedAgentIds={server.allowedAgentIds}
            agents={agents}
            pending={pendingPolicy}
            error={failedPolicy}
            onChange={onSetAgentPolicy}
          />
        </div>
      </div>
      <HealthLine server={server} now={now} />
    </div>
  )
}

function ServerMark() {
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground ring-1 ring-inset ring-border/60"
    >
      <HardDrivesIcon className="size-5" weight="duotone" />
    </span>
  )
}

/**
 * D6's answer to "what does this server cost me": every tool is imported, so
 * the count and the per-turn token estimate are the whole of the budget
 * conversation. A server with nothing measured yet says nothing rather than
 * printing zeroes that would read as free.
 */
function ToolCost({ server }: { server: McpServer }) {
  const t = useTranslations('duetIntegrations.mcpServers')
  if (server.toolCount === undefined) return null
  return (
    <span className="min-w-0 truncate">
      {t('tools', { count: server.toolCount })}
      {server.estimatedPromptBytes === undefined
        ? null
        : ` · ${t('cost', { tokens: Math.round(server.estimatedPromptBytes / BYTES_PER_TOKEN) })}`}
    </span>
  )
}

/**
 * Tools this workspace asked for and did not get. Its own line with its own
 * icon, not a third item in the count run: chained to the counts by a middot
 * and separated only by colour, two independent reviewers read a real loss as
 * more arithmetic.
 */
function DroppedTools({ server }: { server: McpServer }) {
  const t = useTranslations('duetIntegrations.mcpServers')
  const dropped = server.droppedToolNames?.length ?? 0
  if (dropped === 0) return null
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
      <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />
      <span className="min-w-0 truncate">{t('dropped', { count: dropped })}</span>
    </span>
  )
}

/**
 * The only channel this feature has. A server the runner cannot reach is
 * otherwise completely invisible: the runner warns it away and the turn goes on
 * without its tools, so nothing else in the product would ever say so.
 */
function HealthLine({ server, now }: { server: McpServer; now: number }) {
  const t = useTranslations('duetIntegrations.mcpServers')
  const format = useFormatter()
  const when = (at: number) => format.relativeTime(at, now)
  const failure = (code: McpServerErrorCode) => ({
    tone: 'error' as const,
    text: t(`health.${code}`),
    at: server.lastErrorAt ?? server.updatedAt,
  })
  const health = (() => {
    if (server.state === 'disconnecting')
      return { tone: 'muted' as const, text: t('health.disconnecting') }
    // A terminal credential state outranks the row's last call: the next call
    // cannot succeed until someone reconnects it.
    if (server.state === 'reauth_required') return failure('reauth_required')
    if (server.state === 'needs_auth') return { tone: 'warn' as const, text: t('health.needsAuth') }
    const failedLast =
      server.lastErrorAt !== undefined &&
      (server.lastSuccessAt === undefined || server.lastErrorAt > server.lastSuccessAt)
    if (failedLast) return failure(server.lastErrorCode ?? 'upstream_error')
    if (server.lastSuccessAt === undefined)
      return { tone: 'muted' as const, text: t('health.idle') }
    return { tone: 'ok' as const, text: t('health.ok'), at: server.lastSuccessAt }
  })()

  return (
    <p
      data-mcp-server-health={server.name}
      className={cn(
        /* Every tone is a tinted band, not just the unhappy ones: a healthy
           server and a broken one must read as the same element in two
           colours, or the row's structure changes with its state. */
        'flex items-center gap-2 border-t border-border/45 px-4 py-2 text-xs font-medium',
        health.tone === 'error'
          ? 'bg-destructive/5 text-destructive'
          : health.tone === 'warn'
            ? 'bg-amber-500/5 text-amber-700 dark:text-amber-300'
            : health.tone === 'ok'
              ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
              : 'bg-muted/40 text-muted-foreground',
      )}
    >
      {/* Filled, because at 14px an outline glyph is read as a colour rather
          than a shape — which would make the state colour-only. */}
      {health.tone === 'error' ? (
        <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />
      ) : health.tone === 'warn' ? (
        <ClockIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />
      ) : health.tone === 'ok' ? (
        <CheckCircleIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />
      ) : (
        <CircleDashedIcon className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 truncate">{health.text}</span>
      {/* When it happened is not itself the alarm, so it does not wear the
          alarm's colour. */}
      {health.at === undefined ? null : (
        <span className="shrink-0 font-normal text-muted-foreground">{`· ${when(health.at)}`}</span>
      )}
    </p>
  )
}

/**
 * Check first, add second. The check is the same probe the add route runs
 * server-side, so nothing is written by asking — and it is what makes D6's
 * numbers available *before* the decision rather than after it.
 */
function AddMcpServerDialog({
  existingNames,
  serverCount,
  onProbe,
  onAdd,
  onCancel,
}: {
  existingNames: string[]
  serverCount: number
  onProbe(input: McpServerProbeRequest, signal: AbortSignal): Promise<McpServerProbe>
  onAdd(input: AddMcpServerRequest): void
  onCancel(): void
}) {
  const t = useTranslations('duetIntegrations.mcpServers.dialog')
  const id = useId()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [token, setToken] = useState('')
  const [wantsToken, setWantsToken] = useState(false)
  const [checking, setChecking] = useState(false)
  const [probe, setProbe] = useState<McpServerProbe>()
  const [error, setError] = useState<string>()
  const request = useRef<AbortController | undefined>(undefined)

  const suggested = nameTouched ? name : mcpServerNameSuggestion(url)
  const draft = { url: url.trim(), name: suggested.trim(), token: token.trim() }
  const auth =
    wantsToken && draft.token !== '' ? { kind: 'static' as const, token: draft.token } : undefined

  const check = () => {
    const invalid = draftError(draft, existingNames, serverCount)
    if (invalid !== undefined) {
      setError(t(invalid, { count: MAX_MCP_SERVERS_PER_WORKSPACE }))
      return
    }
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setError(undefined)
    setProbe(undefined)
    setChecking(true)
    void onProbe({ name: draft.name, url: draft.url, ...(auth ? { auth } : {}) }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setProbe(result)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setError(t('probeFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
  }

  const cancel = () => {
    request.current?.abort()
    onCancel()
  }

  return (
    <Dialog open onOpenChange={next => !next && cancel()}>
      <DialogContent className="sm:max-w-md" data-testid="mcp-server-add">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault()
            if (probe === undefined) {
              check()
              return
            }
            onAdd({
              name: draft.name,
              url: draft.url,
              auth: probe.auth === 'oauth' ? { kind: 'oauth' } : (auth ?? { kind: 'none' }),
            })
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor={`${id}-url`}>
              {t('urlLabel')}
            </label>
            <Input
              id={`${id}-url`}
              autoFocus
              inputMode="url"
              value={url}
              placeholder={t('urlPlaceholder')}
              onChange={event => {
                setUrl(event.target.value)
                setProbe(undefined)
                setError(undefined)
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor={`${id}-name`}>
              {t('nameLabel')}
            </label>
            <Input
              id={`${id}-name`}
              value={suggested}
              onChange={event => {
                setNameTouched(true)
                setName(event.target.value)
                setProbe(undefined)
                setError(undefined)
              }}
            />
            <p className="text-xs text-muted-foreground">{t('nameHint')}</p>
          </div>
          <div className="space-y-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                checked={wantsToken}
                onChange={event => {
                  setWantsToken(event.target.checked)
                  setProbe(undefined)
                }}
                className="size-4 accent-brand"
              />
              {t('tokenToggle')}
            </label>
            {wantsToken ? (
              <>
                <label className="sr-only" htmlFor={`${id}-token`}>
                  {t('tokenLabel')}
                </label>
                <Input
                  id={`${id}-token`}
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={event => {
                    setToken(event.target.value)
                    setProbe(undefined)
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
              </>
            ) : null}
          </div>
          {checking ? null : error !== undefined ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          ) : probe === undefined ? null : probe.auth === 'oauth' ? (
            <div className="rounded-md bg-muted/60 px-2.5 py-2">
              <p className="text-xs font-medium">{t('oauthTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('oauthBody')}</p>
            </div>
          ) : (
            <div
              className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2"
              data-testid="mcp-server-probe"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircleIcon className="size-3.5" weight="fill" aria-hidden />
                {t('reachable')}
              </p>
              <ProbeSummary probe={probe} />
            </div>
          )}
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" className="text-foreground" onClick={cancel}>
              {t('cancel')}
            </Button>
            {/* One progress indicator, in the control that started it — the
                same shape the connect button next door uses. */}
            <Button type="submit" disabled={checking} data-testid="mcp-server-add-confirm">
              {checking ? <CircleNotchIcon className="size-3.5 animate-spin" aria-hidden /> : null}
              {checking ? t('checking') : probe === undefined ? t('check') : t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProbeSummary({ probe }: { probe: McpServerProbe }) {
  const t = useTranslations('duetIntegrations.mcpServers')
  const dropped = probe.droppedToolNames?.length ?? 0
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      {t('tools', { count: probe.toolCount })}
      {` · ${t('cost', { tokens: Math.round(probe.estimatedPromptBytes / BYTES_PER_TOKEN) })}`}
      {dropped > 0 ? ` · ${t('dropped', { count: dropped })}` : null}
    </p>
  )
}

/**
 * The name is the tool-name prefix every agent will read, so it is offered
 * rather than derived: the host's most distinctive label is a better first
 * guess than the whole hostname, and the field stays editable.
 */
export function mcpServerNameSuggestion(url: string): string {
  let host: string
  try {
    host = new URL(url.trim()).hostname
  } catch {
    return ''
  }
  const labels = host.split('.').filter(label => label !== '')
  while (labels.length > 1 && ['www', 'mcp', 'api'].includes(labels[0] ?? '')) labels.shift()
  const candidate = (labels[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return McpServerNameSchema.safeParse(candidate).success ? candidate : ''
}

export function draftError(
  draft: { url: string; name: string },
  existingNames: string[],
  serverCount: number,
): 'invalidUrl' | 'invalidName' | 'duplicateName' | 'limit' | undefined {
  if (serverCount >= MAX_MCP_SERVERS_PER_WORKSPACE) return 'limit'
  if (!McpServerUrlSchema.safeParse(draft.url).success) return 'invalidUrl'
  if (!McpServerNameSchema.safeParse(draft.name).success) return 'invalidName'
  if (existingNames.includes(draft.name)) return 'duplicateName'
  return undefined
}

/**
 * The connect route's own refusals, each of which names a different next move.
 * Anything else — including the 502 it keeps for its own failures — gets the
 * general message rather than a code the user cannot read: a consent that never
 * reached a consent page must still say something, or the click looks like a
 * no-op and the user presses it again.
 */
const CONNECT_ERROR_CODES = [
  'oauth_unsupported',
  'server_unreachable',
  'registration_failed',
  'url_not_allowed',
] as const

function connectErrorKey(code: string | undefined): string {
  return CONNECT_ERROR_CODES.some(known => known === code)
    ? `connectError.${code}`
    : 'connectError.default'
}

/** The address without its scheme: what distinguishes two rows, nothing more. */
function displayOrigin(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}
