'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import type { UserBillingOverview, WhoamiResponse, WorkspaceSummary } from '@repo/contract'
import { OverlaySuspendedContext } from '@repo/ui/lib/overlay-scope'

import { duetQueryKeys } from '../api/query-keys'
import { useSpa } from '../context'
import { useCheckoutCelebration } from './checkout-celebration'
import { createCheckoutReturnRefresher } from './checkout-return-refresh'
import { CHECKOUT_CELEBRATION_POLL_MS } from './checkout-success-signal'
import { HostedCheckoutPopupBlockedError, openHostedCheckout } from './hosted-checkout'
import { LowCreditGate, type LowCreditGateState } from './low-credit-gate'
import {
  deriveWorkspaceWall,
  SubscribeWall,
  summarizeWorkspaceMomentum,
  type WorkspaceMomentum,
  type WorkspaceWallState,
} from './subscribe-wall'
import { billingFooterActionClassName } from './billing-footer-action'

export type WorkspaceBillingSurface =
  | { kind: 'entitlement'; wall: WorkspaceWallState }
  | { kind: 'low-credit'; state: LowCreditGateState }
  | { kind: 'celebration' }
  | null

export function deriveWorkspaceBillingSurface(
  workspace: WorkspaceSummary,
  identity: { user: Pick<WhoamiResponse['user'], 'id'> },
  billing: UserBillingOverview | undefined,
  celebrating = false,
): WorkspaceBillingSurface {
  const wall = deriveWorkspaceWall(workspace, identity.user.id, billing)
  // A payment cannot be taken on faith here: the entitlement wall stands for a
  // workspace whose servicing is actually stopped, and waving someone through
  // it would hand them a workspace that still cannot run anything.
  if (wall !== null) return { kind: 'entitlement', wall }
  // Credit lives on the payer's own wallet, so their fresh checkout speaks for
  // every workspace they fund — and for none that they merely belong to.
  const viewerIsPayer = workspace.billingUserId === identity.user.id
  if (celebrating && viewerIsPayer) return { kind: 'celebration' }
  if (workspace.creditRecovery === null) return null
  if (!viewerIsPayer) {
    return { kind: 'low-credit', state: { kind: 'member', workspace } }
  }
  return {
    kind: 'low-credit',
    state: { kind: workspace.creditRecovery, workspace },
  }
}

export function WorkspaceBillingBoundary({
  workspace,
  onSwitchWorkspace,
  recoveryView = false,
  children,
}: {
  workspace: WorkspaceSummary
  /** Where a switch lands is the shell's call; billing surfaces only offer the door. */
  onSwitchWorkspace(workspace: WorkspaceSummary): void
  recoveryView?: boolean
  children: ReactNode
}) {
  const { identity, billingOverview } = useSpa()
  const recoveryKey = `${workspace.slug}:${workspace.billingUserId}:${workspace.servicingStatus}:${workspace.creditRecovery ?? 'none'}`
  const { celebrating, redeem } = useCheckoutCelebration(recoveryKey)
  // Retained artifact access is independent of a running or funded VM. The
  // shell admits only the owner’s Backups Settings destination to this lane.
  const surface = recoveryView
    ? null
    : deriveWorkspaceBillingSurface(workspace, identity, billingOverview, celebrating)
  const blocked = surface !== null && surface.kind !== 'celebration'
  return (
    <div className="relative h-[var(--product-viewport-height,100dvh)] min-h-0 min-w-0">
      <div data-workspace-content inert={blocked} className="h-full min-h-0 min-w-0">
        <OverlaySuspendedContext.Provider value={blocked}>
          {children}
        </OverlaySuspendedContext.Provider>
      </div>
      <WorkspaceBillingRecovery
        key={recoveryKey}
        workspace={workspace}
        surface={surface}
        celebrating={celebrating}
        redeem={redeem}
        onSwitchWorkspace={onSwitchWorkspace}
      />
    </div>
  )
}

function WorkspaceBillingRecovery({
  workspace,
  surface,
  celebrating,
  redeem,
  onSwitchWorkspace,
}: {
  workspace: WorkspaceSummary
  surface: WorkspaceBillingSurface
  celebrating: boolean
  redeem(): void
  onSwitchWorkspace(workspace: WorkspaceSummary): void
}) {
  const t = useTranslations('duetLowCreditGate')
  const backupCopy = useTranslations('duetSettings.workspace.backups')
  const { api, identity, logout } = useSpa()
  const queryClient = useQueryClient()
  // Prime this from every active shell: once servicing pauses, D8 deliberately
  // closes apps/files, while React Query retains this existing-workspace recap.
  const momentum = useWorkspaceMomentum(workspace.slug)
  const entitlementCheckout = useMutation({
    mutationFn: async (plan: Parameters<typeof api.createSubscriptionCheckout>[0]['plan']) =>
      await api.createSubscriptionCheckout({ workspaceSlug: workspace.slug, plan }),
    onSuccess: result => window.location.assign(result.url),
  })
  const billingPortal = useMutation({
    mutationFn: () => api.createBillingPortal(workspace.slug),
    onSuccess: result => window.location.assign(result.url),
  })
  const [checkoutLaunched, setCheckoutLaunched] = useState(false)
  const [checkoutPending, setCheckoutPending] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string>()
  const checkoutPendingRef = useRef(false)
  const viewerIsPayer = workspace.billingUserId === identity.user.id
  const workspaceSwitch = { workspaces: identity.workspaces, onSelect: onSwitchWorkspace }
  const recoveryLink =
    workspace.role === 'owner' ? (
      <Link to={`/w/${workspace.slug}/settings/backups`} className={billingFooterActionClassName}>
        {backupCopy('manage')}
      </Link>
    ) : undefined

  const refreshAfterCheckout = useMemo(
    () =>
      createCheckoutReturnRefresher(async () => {
        const refreshes: Promise<unknown>[] = [
          queryClient.refetchQueries({
            queryKey: duetQueryKeys.identity,
            exact: true,
            type: 'active',
          }),
        ]
        if (viewerIsPayer) {
          refreshes.push(
            queryClient.refetchQueries({
              queryKey: duetQueryKeys.user.billing.overview,
              exact: true,
              type: 'active',
            }),
          )
        }
        await Promise.all(refreshes)
      }),
    [queryClient, viewerIsPayer],
  )

  const gateStoodAside = surface?.kind === 'celebration'
  const awaitingCheckout = gateStoodAside || (checkoutLaunched && surface?.kind === 'low-credit')

  useEffect(() => {
    if (!awaitingCheckout) return
    const refresh = () => void refreshAfterCheckout().catch(() => {})
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [awaitingCheckout, refreshAfterCheckout])

  // A paid checkout is chased on a timer rather than only on return: this
  // surface has already stepped aside on the payer's word, and the baseline
  // entitlement poll is far too slow to make good on that within the grace.
  useEffect(() => {
    if (!gateStoodAside) return
    const refresh = () => void refreshAfterCheckout().catch(() => {})
    refresh()
    const timer = setInterval(refresh, CHECKOUT_CELEBRATION_POLL_MS)
    return () => clearInterval(timer)
  }, [gateStoodAside, refreshAfterCheckout])

  useEffect(() => {
    if (surface?.kind === 'low-credit') return
    checkoutPendingRef.current = false
    setCheckoutLaunched(false)
    setCheckoutPending(false)
    setCheckoutError(undefined)
  }, [surface?.kind, workspace.slug])

  // Credit is one wallet, so any funded workspace of the payer's is the server
  // agreeing the payment landed. The grace has done its job and is spent here
  // rather than left to lapse, so it cannot answer for a later, real shortfall.
  useEffect(() => {
    if (celebrating && viewerIsPayer && workspace.creditRecovery === null) redeem()
  }, [celebrating, redeem, viewerIsPayer, workspace.creditRecovery])

  const launch = useCallback(
    async (createUrl: () => Promise<string>) => {
      if (checkoutPendingRef.current) return
      checkoutPendingRef.current = true
      setCheckoutPending(true)
      setCheckoutError(undefined)
      try {
        await openHostedCheckout(createUrl)
        setCheckoutLaunched(true)
      } catch (error) {
        setCheckoutError(
          error instanceof HostedCheckoutPopupBlockedError
            ? t('popupBlockedError')
            : t('checkoutError'),
        )
      } finally {
        checkoutPendingRef.current = false
        setCheckoutPending(false)
      }
    },
    [t],
  )

  if (surface === null) return null
  if (surface.kind === 'celebration') return null
  if (surface.kind === 'entitlement') {
    return (
      <SubscribeWall
        onLogout={logout}
        billingPortal={
          viewerIsPayer
            ? {
                onOpen: () => billingPortal.mutate(),
                pending: billingPortal.isPending,
                failed: billingPortal.isError,
              }
            : undefined
        }
        state={surface.wall}
        momentum={momentum}
        workspaceSwitch={workspaceSwitch}
        recoveryLink={recoveryLink}
        onSubscribe={plan => entitlementCheckout.mutate(plan)}
      />
    )
  }
  if (surface.state.kind === 'member') {
    return (
      <LowCreditGate
        state={surface.state}
        workspaceSwitch={workspaceSwitch}
        recoveryLink={recoveryLink}
      />
    )
  }
  if (surface.state.kind === 'subscribe') {
    return (
      <LowCreditGate
        state={surface.state}
        pending={checkoutPending}
        error={checkoutError}
        workspaceSwitch={workspaceSwitch}
        recoveryLink={recoveryLink}
        onSubscribe={plan =>
          void launch(async () => {
            const result = await api.createSubscriptionCheckout({
              workspaceSlug: workspace.slug,
              plan,
            })
            return result.url
          })
        }
      />
    )
  }
  return (
    <LowCreditGate
      state={surface.state}
      pending={checkoutPending}
      error={checkoutError}
      workspaceSwitch={workspaceSwitch}
      recoveryLink={recoveryLink}
      onTopup={amountMicroUsd =>
        void launch(async () => {
          const result = await api.createBillingCheckout({
            workspaceSlug: workspace.slug,
            amountMicroUsd,
          })
          return result.url
        })
      }
    />
  )
}

function useWorkspaceMomentum(workspaceSlug: string): WorkspaceMomentum {
  const { api } = useSpa()
  const query = useQuery({
    queryKey: duetQueryKeys.workspaces.entitlementMomentum(workspaceSlug),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const [ledger, apps, files] = await Promise.allSettled([
        api.workspaceLedger(workspaceSlug, { signal }),
        api.listApps(workspaceSlug, { signal }),
        api.listWorkspaceFiles(workspaceSlug, undefined, { signal }),
      ])
      return summarizeWorkspaceMomentum({
        ledgerEntries: ledger.status === 'fulfilled' ? ledger.value.items : [],
        ledgerEntriesIncomplete: ledger.status === 'fulfilled' && ledger.value.nextCursor !== null,
        apps: apps.status === 'fulfilled' ? apps.value.items : [],
        appsIncomplete: apps.status === 'fulfilled' && apps.value.nextCursor !== null,
        rootEntries: files.status === 'fulfilled' ? files.value.items : [],
        rootEntriesIncomplete: files.status === 'fulfilled' && files.value.nextCursor !== null,
      })
    },
  })
  return query.data ?? { generations: 0, publishedApps: 0, organizedFiles: 0 }
}
