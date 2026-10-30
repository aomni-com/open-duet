'use client'

import { Check, WarningCircle, X } from '@phosphor-icons/react'

import type { WorkspaceRole } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'

export type ConsentPanelProps = {
  capabilities: readonly string[]
  workspaces: readonly { slug: string; name: string; role: WorkspaceRole }[]
  selectedSlug?: string
  onSelect(slug: string): void
  client?: { name: string; redirectHost?: string; redirectIsLocalhost?: boolean }
  emptyExplanation: string
  approveLabel: string
  busy?: boolean
  onApprove(): void
  onDeny(): void
}

export function ConsentClientIdentity({
  client,
}: {
  client: NonNullable<ConsentPanelProps['client']>
}) {
  return (
    <div className="mt-3 rounded-xl border bg-background p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Requesting client
      </p>
      <p className="mt-1 break-words font-semibold text-foreground">{client.name}</p>
      {client.redirectHost ? (
        <p className="mt-1 break-all font-mono text-xs text-foreground/70">
          Redirects to {client.redirectHost}
        </p>
      ) : null}
      {client.redirectIsLocalhost ? (
        <div
          role="alert"
          className="mt-3 flex gap-2 rounded-lg border border-amber-500 bg-amber-500/15 p-3 text-sm leading-5 text-amber-950 dark:text-amber-100"
        >
          <WarningCircle
            aria-hidden
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            weight="fill"
          />
          <p>
            <strong>Localhost redirect.</strong> Another app on this device can impersonate this
            client and receive the authorization response.
          </p>
        </div>
      ) : null}
    </div>
  )
}

export function ConsentPanel({
  capabilities,
  workspaces,
  selectedSlug,
  onSelect,
  client,
  emptyExplanation,
  approveLabel,
  busy = false,
  onApprove,
  onDeny,
}: ConsentPanelProps) {
  const onlyWorkspace = workspaces.length === 1 ? workspaces[0] : undefined
  const clientIdentity = client ? <ConsentClientIdentity client={client} /> : null
  // A localhost redirect is a named impersonation vector: don't let the
  // primary-colored Approve nudge the user past the warning — make the two
  // actions visual peers so the choice is deliberate.
  const approveVariant = client?.redirectIsLocalhost ? 'outline' : 'brand'

  if (workspaces.length === 0) {
    return (
      <>
        {clientIdentity}
        <div className="mt-3 rounded-xl border border-dashed bg-background p-4 text-sm leading-6 text-muted-foreground">
          <strong className="block text-foreground">
            You can&apos;t approve this {client ? 'client' : 'device'}
          </strong>
          {emptyExplanation}
        </div>
        <div className="mt-5 flex">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={onDeny}
          >
            <X /> Deny
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {clientIdentity}
      {onlyWorkspace ? (
        <>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This {client ? 'client' : 'device'} will act as you in your workspace:
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-xl border bg-background px-3 py-2.5 text-sm">
            <strong className="min-w-0 truncate">{onlyWorkspace.name}</strong>
            <span className="ml-auto rounded-full border border-emerald-600 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              your only workspace
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This {client ? 'client' : 'device'} will act as you in{' '}
            <strong className="text-foreground">one workspace</strong>. Choose which:
          </p>
          <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Workspace">
            {workspaces.map(workspace => {
              const selected = workspace.slug === selectedSlug
              return (
                <label
                  key={workspace.slug}
                  className={[
                    'flex cursor-pointer items-center gap-3 rounded-xl border bg-background px-3 py-2.5 text-sm transition-colors',
                    selected ? 'border-brand ring-1 ring-brand' : 'hover:border-foreground/30',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="consent-workspace"
                    value={workspace.slug}
                    checked={selected}
                    onChange={() => onSelect(workspace.slug)}
                    className="accent-brand"
                  />
                  <span className="min-w-0 flex-1 truncate font-semibold">{workspace.name}</span>
                  <span className="ml-auto shrink-0 text-xs capitalize text-muted-foreground">
                    {workspace.role}
                  </span>
                </label>
              )
            })}
          </div>
        </>
      )}
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {capabilities.map(capability => (
          <li
            key={capability}
            className="rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground"
          >
            {capability}
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant={approveVariant}
          className="min-w-0 flex-1"
          isLoading={busy}
          disabled={selectedSlug === undefined}
          onClick={onApprove}
        >
          <Check /> <span className="truncate">{approveLabel}</span>
        </Button>
        <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={onDeny}>
          <X /> Deny
        </Button>
      </div>
    </>
  )
}
