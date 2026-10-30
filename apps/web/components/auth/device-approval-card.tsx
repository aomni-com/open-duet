'use client'

import { Check, ShieldCheck, X } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import type { DeviceApprovalResponse } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import { Input } from '@repo/ui/components/shadcn/input'

export type DeviceInspection = Pick<DeviceApprovalResponse, 'userCode' | 'status' | 'clientName'>

export function DeviceApprovalScreen(props: Parameters<typeof DeviceApprovalCard>[0]) {
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar p-5 sm:p-8">
      <DeviceApprovalCard {...props} />
    </main>
  )
}

export function DeviceApprovalCard({
  userCode,
  inspection,
  busy = false,
  message,
  onUserCodeChange,
  onApprove,
  onDeny,
}: {
  userCode: string
  inspection?: DeviceInspection
  busy?: boolean
  message?: string
  onUserCodeChange?: (code: string) => void
  onApprove?: () => void
  onDeny?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const visibleInspection =
    inspection?.userCode.toUpperCase() === userCode.trim().toUpperCase() ? inspection : undefined
  const pending = visibleInspection?.status === 'pending'
  return (
    <section className="w-full max-w-xl rounded-3xl border bg-background p-7 shadow-xl sm:p-9">
      <div className="grid size-11 place-items-center rounded-2xl bg-brand text-brand-foreground">
        <ShieldCheck size={24} weight="fill" />
      </div>
      <p className="mt-7 text-sm font-medium text-brand">Device login</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in to Duet</h1>
      <p className="mt-3 text-sm leading-6 text-foreground/70">
        Enter the code shown in your terminal. Approve only a device you started yourself.
      </p>
      <label className="mt-6 block text-sm font-medium" htmlFor="device-code">
        Device code
      </label>
      {/* No Inspect button: a complete code looks itself up (spec ledger #29). */}
      <Input
        id="device-code"
        value={userCode}
        onChange={event => onUserCodeChange?.(event.target.value.toUpperCase())}
        placeholder="ABCD-EFGH"
        className="mt-2 h-11 font-mono uppercase tracking-[0.16em]"
      />
      <AnimatePresence initial={false}>
        {visibleInspection ? (
          <motion.div
            className="mt-6 rounded-2xl border bg-muted/70 p-5"
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center justify-between gap-4">
              <p className="font-medium">Device login</p>
              <span className="rounded-full border bg-background px-2.5 py-1 text-xs capitalize text-muted-foreground">
                {visibleInspection.status}
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-foreground/80">
              {pending ? (
                <>
                  {visibleInspection.clientName ? (
                    <>
                      <strong>{visibleInspection.clientName}</strong> wants to sign in to your Duet
                      account.{' '}
                    </>
                  ) : (
                    'This device wants to sign in to your Duet account. '
                  )}
                  Your current workspace membership and role determine what this login can access.
                </>
              ) : visibleInspection.status === 'expired' ? (
                'This code expired. Start login again in your terminal.'
              ) : visibleInspection.status === 'denied' ? (
                'This login request was denied.'
              ) : (
                'This device signed in to your Duet account.'
              )}
            </p>
            {pending ? (
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="brand"
                  className="flex-1"
                  isLoading={busy}
                  onClick={onApprove}
                >
                  <Check /> Sign in
                </Button>
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
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {message ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}
