'use client'

import { ShieldCheck } from '@phosphor-icons/react'

import type { OAuthConsentInspectResponse } from '@repo/contract'

import { ConsentClientIdentity, ConsentPanel } from './consent-panel'

export function OAuthConsentScreen({
  inspection,
  selectedSlug,
  busy = false,
  message,
  onSelect,
  onApprove,
  onDeny,
}: {
  inspection?: OAuthConsentInspectResponse
  selectedSlug?: string
  busy?: boolean
  message?: string
  onSelect?: (slug: string) => void
  onApprove?: () => void
  onDeny?: () => void
}) {
  const selectedWorkspace = inspection?.workspaces.find(
    workspace => workspace.slug === selectedSlug,
  )
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar p-5 sm:p-8">
      <section className="w-full max-w-xl rounded-3xl border bg-background p-7 shadow-xl sm:p-9">
        <div className="grid size-11 place-items-center rounded-2xl bg-brand text-brand-foreground">
          <ShieldCheck size={24} weight="fill" />
        </div>
        <p className="mt-7 text-sm font-medium text-brand">OAuth authorization</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connect a client to Duet</h1>
        <p className="mt-3 text-sm leading-6 text-foreground/70">
          Review the client identity, redirect destination, and access it is requesting.
        </p>
        {inspection ? (
          <div className="mt-6 rounded-2xl border bg-muted/70 p-5">
            <div className="flex items-center justify-between gap-4">
              <p className="font-medium">Requested access</p>
              <span className="rounded-full border bg-background px-2.5 py-1 text-xs capitalize text-muted-foreground">
                {inspection.status}
              </span>
            </div>
            {inspection.status === 'pending' ? (
              <ConsentPanel
                client={{
                  name: inspection.client.name,
                  redirectHost: inspection.redirect.hostname,
                  redirectIsLocalhost: inspection.redirect.localhost,
                }}
                capabilities={inspection.capabilities}
                workspaces={inspection.workspaces}
                selectedSlug={selectedSlug}
                onSelect={slug => onSelect?.(slug)}
                emptyExplanation="This access needs an editor or owner role in a workspace. Ask a workspace owner to upgrade your role, then try again."
                approveLabel={
                  selectedWorkspace ? `Approve for ${selectedWorkspace.name}` : 'Choose a workspace'
                }
                busy={busy}
                onApprove={() => onApprove?.()}
                onDeny={() => onDeny?.()}
              />
            ) : (
              <>
                <ConsentClientIdentity
                  client={{
                    name: inspection.client.name,
                    redirectHost: inspection.redirect.hostname,
                    redirectIsLocalhost: inspection.redirect.localhost,
                  }}
                />
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {terminalStatusMessage(inspection.status)}
                </p>
              </>
            )}
          </div>
        ) : null}
        {busy && !inspection ? (
          <p role="status" className="mt-5 text-sm text-muted-foreground">
            Loading authorization request…
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="mt-5 text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  )
}

function terminalStatusMessage(status: Exclude<OAuthConsentInspectResponse['status'], 'pending'>) {
  switch (status) {
    case 'approved':
      return 'This authorization request has already been approved.'
    case 'denied':
      return 'This authorization request was denied. You can return to the client.'
    case 'expired':
      return 'This authorization request has expired. Start again from the client.'
  }
}
