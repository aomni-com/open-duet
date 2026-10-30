import { SealCheck } from '@phosphor-icons/react'

import { cn } from '@repo/ui/lib/utils'

export function VerifiedPublisherBadge({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <span
      data-verified-publisher-badge="dimensional"
      className={cn(
        'relative isolate inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-full border border-brand/25 bg-gradient-to-b from-background via-brand/[0.07] to-brand/[0.16] px-2.5 text-xs font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-1px_0_rgba(109,94,247,0.18),0_3px_7px_-5px_rgba(55,65,81,0.45),0_1px_3px_-2px_rgba(109,94,247,0.28)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-1px_0_rgba(109,94,247,0.28),0_3px_7px_-5px_rgba(0,0,0,0.6),0_1px_3px_-2px_rgba(109,94,247,0.38)]',
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/80 to-transparent dark:from-white/15"
      />
      <span className="relative grid size-4 place-items-center rounded-full bg-gradient-to-br from-white via-brand/20 to-brand/55 text-brand shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(43,33,120,0.35)] dark:from-white/30 dark:via-brand/25 dark:to-brand/65">
        <SealCheck aria-hidden size={13} weight="fill" className="drop-shadow-[0_1px_0_white]" />
      </span>
      <span className="relative">{label}</span>
    </span>
  )
}
