import { cn } from '@repo/ui/lib/utils'

import { SHARE_COPY_EN, type ShareCopy } from '@/components/landing/landers/section-copy'
import { SectionHeader } from '@/components/landing/landers/section-primitives'

/** Share: an agent, a folder, or an app goes to someone else the way a file
 * does. The section's point sits on its last card, on the inverted surface. */
export function ShareSection({ copy = SHARE_COPY_EN }: { copy?: ShareCopy }) {
  const last = copy.cards.length - 1
  return (
    <section className="border-y border-foreground/10 bg-foreground/[0.02]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro} />
        <div className={cn('mt-12 grid gap-6 md:grid-cols-2', last > 1 && 'lg:grid-cols-3')}>
          {copy.cards.map((card, i) => (
            <article
              key={card.label}
              className={cn(
                'rounded-3xl border border-foreground/15 p-7 sm:p-9',
                i === last
                  ? 'bg-foreground text-background shadow-xl shadow-foreground/10'
                  : 'bg-foreground/[0.04]',
                // Three cards on a two-column tablet grid: the loud one spans
                // the row instead of sitting alone beside a hole.
                last > 1 && i === last && 'md:col-span-2 lg:col-span-1',
              )}
            >
              <p
                className={cn(
                  'text-xs font-semibold uppercase tracking-[0.16em]',
                  i === last ? 'text-background/75' : 'text-foreground/70',
                )}
              >
                {card.label}
              </p>
              <h3 className="mt-8 text-balance text-2xl font-semibold tracking-[-0.025em]">
                {card.title}
              </h3>
              <p
                className={cn(
                  'mt-3 max-w-xl text-pretty leading-relaxed',
                  i === last ? 'text-background/70' : 'text-foreground/70',
                )}
              >
                {card.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
