'use client'

/* One provider's mark, wherever a connection is drawn.

   It lives on its own because two surfaces draw connections now — the
   Integrations destination, and the right-hand column inside an agent — and the
   mark is the only thing about a connection that is recognisable at a glance.
   Two implementations of it would drift, and the day one of them fell back to
   an initial while the other did not, the same account would be two different
   pictures on two screens in the same product. */

export function IntegrationMark({
  name,
  logoUrl,
  size = 10,
}: {
  name: string
  logoUrl?: string
  /** Tailwind's `size-*` step. The destination lists at 10; a rail lists at 7. */
  size?: 7 | 10
}) {
  const box = size === 7 ? 'size-7' : 'size-10'
  return logoUrl ? (
    // Provider logos are runtime URLs outside Next's static image allowlist.
    // oxlint-disable-next-line eslint-plugin-next/no-img-element
    <img
      src={logoUrl}
      alt=""
      className={`${box} shrink-0 rounded-lg border bg-white object-contain p-1`}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`${box} flex shrink-0 items-center justify-center rounded-lg border border-brand/10 bg-brand/[0.07] font-bold text-brand ${size === 7 ? 'text-xs' : 'text-sm'}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
