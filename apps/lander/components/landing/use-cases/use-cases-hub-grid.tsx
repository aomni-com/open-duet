import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr'

import { cn } from '@repo/ui/lib/utils'

import { Link } from '@/i18n/navigation'

import { getUseCasePersonas, type UseCasePersona } from './use-cases-spec'

function PersonaCard({ persona }: { persona: UseCasePersona }) {
  // Surface the first two use-case titles as a teaser. Keeps the grid
  // dense without forcing the eye through a wall of bullet text.
  const teasers = persona.useCases.slice(0, 2)

  return (
    <Link
      href={`/use-cases/${persona.slug}`}
      className={cn(
        // Card is a real anchor so the whole tile is clickable / focusable
        // / linkable for crawlers. No nested links — title and teasers
        // are spans, not <a>s.
        'group relative flex h-full flex-col gap-5 rounded-2xl border p-6 transition-[transform,box-shadow,border-color] duration-200 ease-out',
        'border-lv2-line bg-lv2-surface shadow-lv2-card',
        'hover:-translate-y-0.5 hover:border-lv2-line-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lv2-accent)]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {/* Brand-blue dot acts as the persona's accent — the same dot
              shows up in the navbar dropdown so the visual language
              matches across surfaces. */}
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-[var(--lv2-accent)] shadow-[0_0_0_3px_var(--lv2-accent-soft)]"
          />
          <span className="lv2-eyebrow">{persona.shortName}</span>
        </div>
        <ArrowUpRightIcon
          weight="bold"
          className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          aria-hidden="true"
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)]">
          {persona.name}
        </h3>
        <p className="text-sm text-[var(--lv2-muted)]">{persona.primaryKeyword}</p>
      </div>

      <ul className="mt-auto space-y-2">
        {teasers.map(uc => (
          <li key={uc.id} className="flex gap-2 text-sm leading-snug text-[var(--lv2-fg-soft)]">
            <span
              aria-hidden="true"
              className="mt-2 size-1 shrink-0 rounded-full bg-[var(--lv2-line-strong)]"
            />
            <span>{uc.title}</span>
          </li>
        ))}
      </ul>
    </Link>
  )
}

/**
 * 5-up persona grid used on the /use-cases hub. Pulls directly from
 * the locale-owned persona copy so adding a sixth persona reshapes the grid
 * without touching this file.
 *
 * The grid is intentionally not symmetric on desktop (3 + 2) — five
 * is an awkward number, and forcing a fourth column makes the last
 * card stranded. The 3+2 read is calmer.
 */
export function UseCasesHubGrid({
  personas = getUseCasePersonas(),
}: {
  personas?: UseCasePersona[]
}) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {personas.map(persona => (
        <PersonaCard key={persona.slug} persona={persona} />
      ))}
    </div>
  )
}
