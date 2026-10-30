'use client'

import { useTranslations } from 'next-intl'
import { Link } from 'react-router'

import type { AgentOnboardingTarget } from './agent-onboarding-projection'
import { agentsMapUrl } from './agents-map-url'

export function AgentOnboardingCta({
  workspaceSlug,
  agentSlug,
  target,
  onNavigate,
  onRetry,
}: {
  workspaceSlug: string
  agentSlug: string
  target: AgentOnboardingTarget | undefined
  onNavigate?: () => void
  /**
   * The host is already the agent's own surface, where a chat setup opens on
   * sight — so a link there would be a button that does nothing. What that
   * host needs from this control is the same open asked again; it passes the
   * ask in and the CTA stays the one owner of how the control looks.
   */
  onRetry?: () => void
}) {
  const t = useTranslations('duetApp.agentRoster')
  const className =
    'inline-flex h-10 w-full items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-brand-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring'

  if (target?.kind === 'chat') {
    /* The conversation lives on the agent's own surface — a locked agent
       opens it on sight (open-or-create, see `agent-onboarding-session.ts`) —
       so from anywhere else this is simply the door to that surface. */
    return onRetry !== undefined ? (
      <button type="button" onClick={onRetry} className={`${className} hover:bg-brand/90`}>
        {t('onboardAgent')}
      </button>
    ) : (
      <Link
        to={agentsMapUrl(workspaceSlug, { kind: 'agent', agentSlug, card: { kind: 'default' } })}
        onClick={onNavigate}
        className={`${className} hover:bg-brand/90`}
      >
        {t('onboardAgent')}
      </Link>
    )
  }

  if (target?.kind === 'app' && target.appSlug !== undefined) {
    return (
      <Link
        /* The app opens on its agent's card, which is the only address an app
           has — and the right one here twice over: the watch that notices the
           onboarding finishing lives on that card. */
        to={agentsMapUrl(workspaceSlug, {
          kind: 'agent',
          agentSlug,
          card: { kind: 'app', appSlug: target.appSlug },
        })}
        onClick={onNavigate}
        className={`${className} hover:bg-brand/90`}
      >
        {t('onboardAgent')}
      </Link>
    )
  }

  /* No target at all, or an onboarding app whose runtime has not come up yet —
     `agentOnboardingTarget` withholds the slug until it is reconciled, because
     a button that opens a frame onto a dead port is worse than one that waits. */
  return (
    <button type="button" disabled className={`${className} opacity-50`}>
      {t('onboardAgent')}
    </button>
  )
}
