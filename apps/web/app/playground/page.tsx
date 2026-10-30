import Link from 'next/link'

import { PLAYGROUND_ENTRIES } from './registry'

/* The top section is reserved for fixtures a human walks by hand; the list
   below is what the automated screenshot suite drives. Featured entries are
   still ordinary registry entries — this only pulls them to the top of the
   page. */
const FEATURED = [
  {
    id: 'onboarding-journey',
    title: 'Onboarding journey',
    body: 'Replays a whole first run — the root a just-registered browser lands on, the setup steps, the install wait, and out into the workspace. Pick a run and start it again from the drawer on the left edge; no account is created.',
    action: 'Walk the journey',
  },
] as const

export default function Page() {
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm font-medium text-brand">Visual oracle</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Duet UI playground</h1>
        <p className="mt-3 text-muted-foreground">Deterministic, backend-independent fixtures.</p>

        {FEATURED.map(featured => (
          <div
            key={featured.id}
            className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed bg-card px-5 py-4"
          >
            <div>
              <p className="text-sm font-medium">{featured.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{featured.body}</p>
            </div>
            <Link
              href={`/playground/${featured.id}`}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {featured.action}
              <svg
                viewBox="0 0 16 16"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </Link>
          </div>
        ))}

        <ul className="mt-8 divide-y rounded-2xl border bg-card">
          {PLAYGROUND_ENTRIES.map(entry => (
            <li key={entry.id}>
              <Link
                className="flex items-center justify-between px-5 py-4 hover:bg-muted"
                href={`/playground/${entry.id}`}
              >
                <span className="text-sm font-medium">{entry.title}</span>
                <code className="text-xs text-muted-foreground">{entry.id}</code>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
