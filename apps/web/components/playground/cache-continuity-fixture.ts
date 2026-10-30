/* The two facts the cache-continuity fixture and its walk both have to agree
   on. A `.ts` module rather than the fixture component itself, so the Playwright
   spec can import them without pulling a `'use client'` React tree into its
   process — and so the visual-coverage inventory, which reads `.tsx`, still
   attributes the component to exactly one file. */

/**
 * Never the product's own store: an invented workspace must not end up in the
 * database a real reader's product restores from.
 */
export const FIXTURE_CACHE_DATABASE = 'duet-query-cache-playground'

/** What the fixture's "server" renames the first agent to while nobody is listening. */
export const RENAMED_FIRST_AGENT = 'Nightingale'
