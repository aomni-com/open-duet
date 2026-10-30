'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import { AgentNameSchema, type MarketplaceListingDetail } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { Input } from '@repo/ui/components/shadcn/input'

import { marketplaceAdditionalInstallTarget } from './instance-name'

/**
 * What to call the agent you are installing.
 *
 * One dialog for every publisher. The consent sheet beside it is shown only for
 * unverified ones — consent is a decision about *whose* code runs — but naming
 * is a decision every installer makes, so branching it by publisher would hide
 * the field on the official hub, which is where most installs happen.
 *
 * The field starts EMPTY, showing the listing's slug as a greyed placeholder.
 * That way the choice is always offered but never demanded: type a name and the
 * agent wears it, leave it blank and the agent takes the slug — exactly what it
 * would have been called before anyone was asked. Pre-filling instead would put
 * a value in the box the user has to delete to reject.
 *
 * Additional installs show the folder derived from the chosen name. A path
 * collision returns here with an editable numbered suggestion, keeping the
 * storage detail subordinate to the human name instead of asking for a raw
 * path in a second dialog.
 */
export function MarketplaceInstallNameDialog({
  detail,
  open,
  intent = 'initial',
  initialName = '',
  collision = false,
  onCancel,
  onConfirm,
}: {
  detail: MarketplaceListingDetail
  open: boolean
  intent?: 'initial' | 'additional'
  initialName?: string
  collision?: boolean
  onCancel: () => void
  onConfirm: (name: string) => void
}) {
  const t = useTranslations('duetApp.marketplace.installName')
  const [name, setName] = useState('')

  // Reset from the ceremony whenever it opens. A collision deliberately seeds
  // the editable suggestion; an ordinary install starts empty.
  useEffect(() => {
    if (open) setName(initialName)
  }, [open, detail.id, initialName])

  const trimmed = name.trim()
  const target = marketplaceAdditionalInstallTarget(trimmed)
  const usable =
    intent === 'initial'
      ? trimmed === '' || AgentNameSchema.safeParse(trimmed).success
      : target !== undefined

  return (
    <Dialog open={open} onOpenChange={next => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="marketplace-install-name">
        <DialogHeader>
          <DialogTitle>{t(collision ? 'collisionTitle' : 'title')}</DialogTitle>
          <DialogDescription>
            {t(
              collision
                ? 'collisionDescription'
                : intent === 'additional'
                  ? 'additionalDescription'
                  : 'description',
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault()
            if (usable) onConfirm(trimmed)
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="marketplace-install-name-input">
              {t('label')}
            </label>
            <Input
              id="marketplace-install-name-input"
              autoFocus
              value={name}
              placeholder={detail.agentName}
              onChange={event => setName(event.target.value)}
            />
            {/* A disabled button with no reason leaves someone retyping the
                same rejected name. Both intents run the name through the same
                schema, so both owe the same explanation. Only once they have
                typed something: an empty field is not yet a mistake. */}
            {trimmed !== '' && !usable ? (
              <p role="alert" className="text-xs text-destructive">
                {t('invalidName')}
              </p>
            ) : null}
            {intent === 'additional' ? (
              <div
                data-testid="marketplace-install-path-preview"
                className="rounded-md bg-muted/60 px-2.5 py-2"
              >
                <p className="text-[11px] font-medium text-muted-foreground">{t('folderLabel')}</p>
                <p className="mt-0.5 font-mono text-xs text-foreground/80">
                  {target?.path ?? t('pathPreviewPending')}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('hint', { slug: detail.agentName })}
              </p>
            )}
          </div>
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" className="text-foreground" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!usable} data-testid="marketplace-install-name-confirm">
              {t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
