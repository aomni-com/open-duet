'use client'

import { useTranslations } from 'next-intl'
import { useRef, useState } from 'react'
import { Link } from 'react-router'

import {
  normalizeSlug,
  WorkspaceCreateRefusalSchema,
  type WorkspaceCreateRefusal,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { Dialog, DialogContent, DialogTitle } from '@repo/ui/components/shadcn/dialog'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'

/**
 * Why the drive was not born. `unknown` is the honest answer for everything the
 * API has not given a reason for — an outage must never be reported as a bill.
 */
export type DriveRefusal = WorkspaceCreateRefusal | 'unknown'

export function refusalOf(error: unknown): DriveRefusal {
  if (!(error instanceof DuetApiError)) return 'unknown'
  const parsed = WorkspaceCreateRefusalSchema.safeParse(error.data)
  return parsed.success ? parsed.data : 'unknown'
}

/**
 * A refusal with somewhere to go beats a sentence that only closes a door: the
 * creation limit is the product working, and the reader can act on it.
 */
export function CreateDriveRefusal({
  refusal,
  onNavigate,
}: {
  refusal: DriveRefusal
  onNavigate?: () => void
}) {
  const t = useTranslations('duetApp')
  if (refusal === 'unknown') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('createWorkspaceError')}
      </p>
    )
  }
  return (
    <div role="alert" className="rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">{t('workspaceLimitTitle', { plan: refusal.plan })}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('workspaceLimitBody', { limit: refusal.limit })}{' '}
        {t('workspaceLimitResolution', { plan: refusal.plan })}
      </p>
      <Link
        to="/settings/billing"
        onClick={onNavigate}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
      >
        {t('workspaceLimitAction')}
      </Link>
    </div>
  )
}

export function CreateWorkspaceDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose(): void
  onCreate(input: { name: string; slug: string }): Promise<void>
}) {
  const t = useTranslations('duetApp')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<DriveRefusal>()
  const nameInput = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !pending) onClose()
      }}
    >
      <DialogContent
        hideCloseButton
        className="max-w-md rounded-xl"
        onOpenAutoFocus={event => {
          event.preventDefault()
          nameInput.current?.focus()
        }}
      >
        <DialogTitle className="text-xl">{t('createWorkspace')}</DialogTitle>
        <form
          className="mt-5 space-y-4"
          onSubmit={event => {
            event.preventDefault()
            setPending(true)
            setRefusal(undefined)
            void onCreate({ name: name.trim(), slug: slug.trim() })
              .then(() => {
                setName('')
                setSlug('')
                setSlugEdited(false)
                onClose()
              })
              .catch((error: unknown) => setRefusal(refusalOf(error)))
              .finally(() => setPending(false))
          }}
        >
          <label className="block text-sm font-medium">
            {t('workspaceName')}
            <input
              ref={nameInput}
              required
              maxLength={80}
              value={name}
              onChange={event => {
                const next = event.target.value
                setName(next)
                if (!slugEdited) setSlug(normalizeSlug(next))
              }}
              className="mt-2 h-9 w-full rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block text-sm font-medium">
            {t('workspaceSlug')}
            <div className="mt-2 flex min-h-9 items-center rounded-md border bg-muted/40 px-3 focus-within:ring-2 focus-within:ring-ring">
              <span className="text-sm text-muted-foreground">duet.so/</span>
              <input
                required
                value={slug}
                onChange={event => {
                  setSlugEdited(true)
                  setSlug(normalizeSlug(event.target.value))
                }}
                className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
              />
            </div>
          </label>
          {refusal ? <CreateDriveRefusal refusal={refusal} onNavigate={onClose} /> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={pending || name.trim().length === 0 || slug.length === 0}
              className={buttonVariants()}
            >
              {pending ? t('creating') : t('create')}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
