import Link from 'next/link'

import { PLAYGROUND_ENTRIES, type LanderPlaygroundGroup } from './registry'

const GROUP_TITLES: Record<LanderPlaygroundGroup, string> = {
  chrome: 'Chrome',
  demos: 'Demos',
  sections: 'Sections',
  atoms: 'Atoms',
}

const GROUP_ORDER: readonly LanderPlaygroundGroup[] = ['chrome', 'demos', 'sections', 'atoms']

/** The menu of lander building blocks. New landers get composed from these
 * pieces; each entry renders one of them in isolation, deterministically,
 * and the visual gate screenshots every entry on desktop and mobile. */
export default function Page() {
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm font-medium text-foreground/60">Visual oracle</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Duet lander playground</h1>
        <p className="mt-3 text-muted-foreground">
          The menu of sections and pieces the landers are built from — deterministic,
          backend-independent, one screenshot each.
        </p>

        {GROUP_ORDER.map(group => (
          <section key={group} className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-foreground/50">
              {GROUP_TITLES[group]}
            </h2>
            <ul className="mt-3 divide-y divide-foreground/5 rounded-2xl border border-foreground/10">
              {PLAYGROUND_ENTRIES.filter(entry => entry.group === group).map(entry => (
                <li key={entry.id}>
                  <Link
                    href={`/playground/${entry.id}`}
                    className="flex items-center justify-between px-5 py-3 text-sm transition-colors hover:bg-foreground/[0.04]"
                  >
                    <span>{entry.title}</span>
                    <span className="font-mono text-xs text-foreground/40">{entry.id}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
