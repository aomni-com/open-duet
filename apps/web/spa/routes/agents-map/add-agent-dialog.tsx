'use client'

import { ArrowLeftIcon, PenNibIcon, StorefrontIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import type { Agent } from '@repo/contract'
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

import { agentSlugFromName, createOwnAgent } from '../../agents/create-agent'
import { useSpa } from '../../context'

/* ============================================================================
   The one door behind the map's add slot.

   There are two ways to fill a seat on the ring — hire an agent that already
   exists, or write one that does not — and the map used to draw one node for
   each. It drew them as a pair, in one visual language, on one limb, because
   they were never two decisions: they are one decision with two answers. So
   the fork lives here now, as two squares, and the canvas is back to drawing
   what the drive holds rather than what it could hold.

   The squares are the same size on purpose. A primary button and a quiet link
   would be this dialog picking for you, and it has no grounds to: which answer
   is right depends on whether the job already has an agent somewhere, which is
   the thing the reader knows and the product does not.

   Hiring leaves for the marketplace, because a shelf is a page. Writing stays
   here and swaps to the name step — one field, because the name is the only
   decision creation needs, and everything else about the agent is built
   afterwards by talking to it. Staying is not a detail: the alternative is
   closing one modal and opening another over the same backdrop, which reads as
   a flicker rather than as a step.
   ========================================================================= */

export function AddAgentDialog({
  workspaceSlug,
  takenSlugs,
  open,
  onOpenChange,
  onHire,
  onCreated,
}: {
  workspaceSlug: string
  /** the live roster's slugs, so the derived slug steps aside before the server has to */
  takenSlugs: ReadonlySet<string>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the marketplace is a page, so leaving for it is the route's business */
  onHire: () => void
  /** called with the server-confirmed agent; caching and navigation are the route's business */
  onCreated: (agent: Agent) => void
}) {
  const t = useTranslations('duetApp.addAgent')
  const tc = useTranslations('duetApp.createAgent')
  const { api } = useSpa()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const slug = trimmed === '' ? null : agentSlugFromName(trimmed, takenSlugs)

  const create = useMutation({
    mutationFn: async () => {
      if (slug === null) throw new Error('unnamed')
      return await createOwnAgent(api, workspaceSlug, { name: trimmed, slug })
    },
    onSuccess: response => {
      setName('')
      // The REGISTERED slug, not the derived one: registration reports what it
      // actually did, and navigating to our own guess would 404 on the one
      // race this dialog cannot see — a slug claimed between render and click.
      onCreated(response.agent)
    },
  })

  /* Both steps' state is reset on the way out, never on the way in. The fork is
     re-asked every time the slot is clicked, and the answer a reopened dialog
     would have kept is the one the reader is least likely to want twice: they
     just made an agent. */
  const close = (next: boolean) => {
    if (create.isPending) return
    if (!next) {
      create.reset()
      setNaming(false)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {naming ? (
          <>
            <DialogHeader>
              <DialogTitle>{tc('title')}</DialogTitle>
              <DialogDescription>{tc('body')}</DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-2"
              onSubmit={event => {
                event.preventDefault()
                if (slug !== null && !create.isPending) create.mutate()
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={tc('placeholder')}
                aria-label={tc('nameLabel')}
                maxLength={80}
              />
              {/* The address the name earns, shown before it is claimed: the
                  slug is the folder and the URL, and a rename later is a
                  different operation — better to see it now than be surprised
                  by it. */}
              <p className="min-h-4 text-xs text-muted-foreground">
                {slug === null ? ' ' : tc('slugPreview', { slug })}
              </p>
              {create.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {tc('failed')}
                </p>
              )}
              {/* Back rather than close. The fork is one click behind this, and
                  a reader who picked the wrong square should not have to shut
                  the dialog and find the slot again to say so. */}
              <DialogFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={create.isPending}
                  onClick={() => {
                    create.reset()
                    setNaming(false)
                  }}
                >
                  <ArrowLeftIcon className="size-4" />
                  {tc('back')}
                </Button>
                <Button type="submit" disabled={slug === null || create.isPending}>
                  {create.isPending ? tc('creating') : tc('create')}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('body')}</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <DoorTile
                icon={<StorefrontIcon weight="duotone" className="size-7" />}
                title={t('hire.title')}
                body={t('hire.body')}
                onClick={onHire}
              />
              <DoorTile
                icon={<PenNibIcon weight="duotone" className="size-7" />}
                title={t('create.title')}
                body={t('create.body')}
                onClick={() => setNaming(true)}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * One of the two answers, as a square.
 *
 * Square rather than a row because the two are being *compared*, and a stack of
 * rows is a list with a first item in it. The icon sits at the top and the words
 * at the bottom, so the pair reads across at a glance and down at a read.
 */
function DoorTile({
  icon,
  title,
  body,
  onClick,
}: {
  icon: ReactNode
  title: string
  body: string
  onClick: () => void
}) {
  return (
    /* `rounded-lg`, not `xl`: the repo's canon puts tiles a tier below panels,
       and the dialog around these is `sm:rounded-lg` — an inner corner rounder
       than its container reads as a sticker on a card. `bg-muted` rather than
       `bg-card`, because card and the dialog's own background resolve within a
       percent of each other in light mode, and a 1px hairline was the only
       thing saying these are pickable. */
    <button
      type="button"
      onClick={onClick}
      className="group flex aspect-square flex-col items-start justify-center gap-3 rounded-lg border bg-muted/60 p-4 text-left transition-colors hover:border-foreground/25 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {/* Centred as one group rather than pinned to the corners. A square is
          taller than these three lines need, and icon-at-top with words-at-
          bottom spent the difference as a hole down the middle of both tiles.

          The icon carries the distinction between the two answers, so it is
          set well above the body copy rather than in the same grey at the same
          weight — at parity the only thing telling the squares apart was two
          lines of similar-length prose. */}
      <span className="text-foreground/70 transition-colors group-hover:text-foreground">
        {icon}
      </span>
      <span className="grid gap-1">
        <span className="text-sm font-medium leading-none">{title}</span>
        <span className="text-xs leading-snug text-muted-foreground">{body}</span>
      </span>
    </button>
  )
}
