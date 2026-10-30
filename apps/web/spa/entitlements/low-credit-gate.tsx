'use client'

import { Check, CircleNotch, WarningDiamond } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

import type { SubscriptionPlanId, WorkspaceSummary } from '@repo/contract'
import { dollarsToMicroUsd } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import {
  hasWorkspaceToSwitchTo,
  WorkspaceSwitchMenu,
  type WorkspaceSwitch,
} from '../shell/workspace-switch-menu'
import { billingFooterActionClassName } from './billing-footer-action'
import { SubscriptionPlanChooser } from './subscription-plan-chooser'

const TOPUP_AMOUNTS = [20, 50, 100] as const

export type LowCreditGateState =
  | { kind: 'subscribe'; workspace: WorkspaceSummary }
  | { kind: 'topup'; workspace: WorkspaceSummary }
  | { kind: 'member'; workspace: WorkspaceSummary }

type SharedProps = {
  pending?: boolean
  error?: string
  workspaceSwitch?: WorkspaceSwitch
  recoveryLink?: ReactNode
}

export type LowCreditGateProps =
  | (SharedProps & {
      state: Extract<LowCreditGateState, { kind: 'subscribe' }>
      onSubscribe(plan: SubscriptionPlanId): void
      onTopup?: never
    })
  | (SharedProps & {
      state: Extract<LowCreditGateState, { kind: 'topup' }>
      onTopup(amountMicroUsd: number): void
      onSubscribe?: never
    })
  | (SharedProps & {
      state: Extract<LowCreditGateState, { kind: 'member' }>
      onSubscribe?: never
      onTopup?: never
    })

export function LowCreditGate(props: LowCreditGateProps) {
  const { state, pending = false, error, workspaceSwitch, recoveryLink } = props
  const t = useTranslations('duetLowCreditGate')
  const dialogRef = useRef<HTMLElement>(null)
  const memberFocusRef = useRef<HTMLParagraphElement>(null)
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('pro')
  const [selectedTopup, setSelectedTopup] = useState<(typeof TOPUP_AMOUNTS)[number]>(50)

  useEffect(() => {
    const target =
      state.kind === 'member'
        ? memberFocusRef.current
        : (dialogRef.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ??
          dialogRef.current)
    target?.focus()
  }, [pending, state.kind])

  const panel = (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="low-credit-gate-title"
      aria-describedby="low-credit-gate-description"
      tabIndex={-1}
      data-low-credit-gate={state.kind}
      className="w-[calc(100%-1.5rem)] max-w-3xl overflow-hidden rounded-[22px] border border-amber-400/30 bg-[linear-gradient(145deg,rgba(255,255,255,.99),rgba(248,247,243,.99))] outline-none shadow-[0_34px_100px_rgba(15,23,42,.45)] sm:w-[calc(100%-3rem)] dark:border-amber-300/20 dark:bg-[linear-gradient(145deg,rgba(28,30,39,.99),rgba(16,18,25,.99))]"
    >
      <div className="h-2 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-400" />
      <div className="px-5 pb-5 pt-6 sm:px-8 sm:pb-8 sm:pt-7">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
          <span className="grid size-7 place-items-center rounded-full bg-amber-100 dark:bg-amber-400/10">
            <WarningDiamond aria-hidden size={16} weight="fill" />
          </span>
          {t(`${state.kind}.eyebrow`)}
        </div>
        <h1
          id="low-credit-gate-title"
          className="mt-3 text-balance text-3xl font-bold leading-[1.04] tracking-[-0.04em] text-slate-950 sm:text-4xl dark:text-white"
        >
          {t(`${state.kind}.headline`)}
        </h1>
        <p
          id="low-credit-gate-description"
          className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base dark:text-slate-300"
        >
          {t(`${state.kind}.body`, { workspace: state.workspace.name })}
        </p>

        {state.kind === 'member' ? (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white/75 p-4 dark:border-white/10 dark:bg-white/[.04]">
            <p
              ref={memberFocusRef}
              tabIndex={0}
              className="w-fit border-l-2 border-transparent pl-2 font-semibold text-slate-950 outline-none focus-visible:border-slate-400 dark:text-white"
            >
              {t('member.waiting')}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {t('member.waitingBody')}
            </p>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-600" />
              </span>
              {t('member.checking')}
            </div>
            {error === undefined ? null : <RecoveryError>{error}</RecoveryError>}
          </div>
        ) : (
          <>
            <div className="mt-5 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-300">
              <strong className="text-base text-amber-700 dark:text-amber-300">
                {t('remainingAmount')}
              </strong>
              {t('remaining')}
            </div>

            <div className="mt-6">
              {state.kind === 'subscribe' ? (
                <SubscriptionPlanChooser
                  selectedPlan={selectedPlan}
                  onSelect={setSelectedPlan}
                  disabled={pending}
                />
              ) : (
                <div
                  className="grid grid-cols-3 gap-2 sm:gap-3"
                  role="radiogroup"
                  aria-label={t('topup.choices')}
                >
                  {TOPUP_AMOUNTS.map(amount => {
                    const selected = selectedTopup === amount
                    return (
                      <button
                        key={amount}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={pending}
                        onClick={() => setSelectedTopup(amount)}
                        className={cn(
                          'min-h-20 rounded-2xl border bg-white/75 p-3 text-left outline-none transition-[border-color,box-shadow,transform] active:scale-[.99] sm:min-h-24 sm:p-4 dark:bg-white/[.04]',
                          selected
                            ? 'border-amber-500 bg-amber-50/80 shadow-[0_10px_30px_rgba(245,158,11,.14)] ring-2 ring-amber-500/20 dark:bg-amber-400/[.07]'
                            : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <strong className="block text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
                            ${amount}
                          </strong>
                          {selected ? (
                            <span className="grid size-5 place-items-center rounded-full bg-amber-500 text-white">
                              <Check aria-hidden size={12} weight="bold" />
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">
                          {t('topup.reserve')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {error === undefined ? null : <RecoveryError>{error}</RecoveryError>}

            <button
              type="button"
              data-recovery-action
              disabled={pending}
              onClick={() => {
                if ('onSubscribe' in props && props.onSubscribe !== undefined) {
                  props.onSubscribe(selectedPlan)
                } else if ('onTopup' in props && props.onTopup !== undefined) {
                  props.onTopup(dollarsToMicroUsd(selectedTopup))
                }
              }}
              className="mt-4 flex min-h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white shadow-lg shadow-slate-950/15 transition-transform active:scale-[.99] disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-slate-950"
            >
              {pending ? (
                <>
                  <CircleNotch aria-hidden className="mr-2 animate-spin" size={18} />
                  {t('pending')}
                </>
              ) : (
                t(`${state.kind}.action`)
              )}
            </button>
          </>
        )}
        {hasWorkspaceToSwitchTo(state.workspace, workspaceSwitch) || recoveryLink ? (
          <p className="mt-3 flex flex-wrap items-center justify-center gap-3 text-center text-[13px] leading-5 text-slate-600 dark:text-slate-300">
            {hasWorkspaceToSwitchTo(state.workspace, workspaceSwitch) ? (
              <WorkspaceSwitchMenu
                className={billingFooterActionClassName}
                current={state.workspace}
                workspaceSwitch={workspaceSwitch}
              />
            ) : null}
            {recoveryLink}
          </p>
        ) : null}
      </div>
    </section>
  )
  return (
    <div
      className="pointer-events-auto absolute inset-0 z-50 overflow-y-auto bg-slate-950/55 py-4 backdrop-blur-[2px] sm:bg-slate-950/65 sm:py-8 sm:backdrop-blur-[6px]"
      data-low-credit-backdrop
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <div className="flex min-h-full items-center justify-center">{panel}</div>
    </div>
  )
}

function RecoveryError({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-xl border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-200"
    >
      {children}
    </p>
  )
}
