'use client'

import type { MarketplaceListingDetail } from '@repo/contract'
import { ELEVATED_APP_CAPABILITIES } from '@repo/contract'

const ELEVATED = new Set<string>(ELEVATED_APP_CAPABILITIES)

/**
 * The install ceremony for an UNVERIFIED publisher.
 *
 * This is the only screen in the product that tells a user a stranger's code
 * will run on their VM, and — because updates are seamless by design — it is
 * shown once and never again. So it enumerates the real commands and scopes
 * rather than summarising them, and says plainly that updates change these
 * without asking. A verified publisher skips it entirely: consent is a decision
 * about *who* is trusted, and the badge already answers that.
 */
export function MarketplaceConsentSheet({
  detail,
  onConfirm,
  onCancel,
}: {
  detail: MarketplaceListingDetail
  onConfirm: () => void
  onCancel: () => void
}) {
  const scopes = [...new Set(detail.apps.flatMap(app => app.apiScopes))].sort()
  const runs = detail.apps.flatMap(app =>
    app.installCommand === undefined ? [app.command] : [app.installCommand, app.command],
  )

  return (
    <div
      role="dialog"
      aria-label={`Install ${detail.title}`}
      data-testid="marketplace-consent-sheet"
      className="rounded-xl border border-border bg-background p-4"
    >
      <h2 className="text-base font-semibold">Install {detail.title}?</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        by <span className="font-medium">{detail.publisherSlug}</span> · not reviewed by Duet
      </p>

      {runs.length > 0 ? (
        <section className="mt-4" data-testid="marketplace-consent-commands">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Will run on your VM
          </h3>
          <ul className="mt-1 font-mono text-xs">
            {runs.map(command => (
              <li key={command}>$ {command}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {scopes.length > 0 ? (
        <section className="mt-4" data-testid="marketplace-consent-scopes">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workspace access
          </h3>
          <ul className="mt-1 flex flex-wrap gap-1">
            {scopes.map(scope => (
              <li
                key={scope}
                data-elevated={ELEVATED.has(scope) ? 'true' : undefined}
                className="rounded bg-muted px-1.5 py-0.5 text-xs data-[elevated=true]:font-semibold"
              >
                {scope}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Updates apply automatically, including changes to these.
      </p>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          data-testid="marketplace-consent-confirm"
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
        >
          Install
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Consent is scoped to the publisher, not the listing: verified skips it. */
export function requiresInstallConsent(detail: {
  verifiedPublisher: boolean
  apps: readonly unknown[]
}): boolean {
  return !detail.verifiedPublisher && detail.apps.length > 0
}
