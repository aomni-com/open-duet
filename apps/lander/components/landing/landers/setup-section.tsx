import { CheckIcon, XIcon } from '@phosphor-icons/react/dist/ssr'

import type { SetupCopy } from '@/components/landing/landers/section-copy'
import { SectionHeader } from '@/components/landing/landers/section-primitives'

/** The stack a reader would have to assemble to reach the state of the art,
 * set beside the one subscription that replaces it. The list carries the
 * argument: each line is a thing they would otherwise sign up for, connect,
 * pay for, and keep current. */
export function SetupSection({ copy }: { copy: SetupCopy }) {
  return (
    <section className="border-y border-foreground/10 bg-foreground/[0.02]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro} />
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <article className="rounded-3xl border border-foreground/15 bg-foreground/[0.04] p-7 sm:p-9">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/70">
              {copy.before.label}
            </p>
            <ul className="mt-6 space-y-3" role="list">
              {copy.before.items.map(item => (
                <li key={item} className="flex items-start gap-3 text-foreground/70">
                  <XIcon
                    weight="bold"
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-foreground/40"
                  />
                  <span className="text-pretty leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </article>
          <article className="flex flex-col rounded-3xl border border-foreground/15 bg-foreground p-7 text-background shadow-xl shadow-foreground/10 sm:p-9">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-background/75">
              {copy.after.label}
            </p>
            <CheckIcon
              weight="bold"
              aria-hidden="true"
              className="mt-8 size-7 text-background/85"
            />
            <h3 className="mt-4 text-balance text-2xl font-semibold tracking-[-0.025em]">
              {copy.after.title}
            </h3>
            <p className="mt-3 max-w-xl text-pretty leading-relaxed text-background/70">
              {copy.after.body}
            </p>
          </article>
        </div>
      </div>
    </section>
  )
}
