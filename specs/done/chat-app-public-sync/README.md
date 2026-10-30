# chat-app public sync — rationale record

Closed 2026-08-01, and closed for good: chat-app is no longer a source for
Duet's public site. The final reconciliation ran chat-app `faf50f0af` into
`apps/lander` (duet `7c763721`, with `fabe973e`, `7728810e`, and `3505c513`
following from what it exposed). Anything chat-app publishes after that SHA
stays there.

`apps/lander` is the sole owner of every anonymous public surface; the product
is a sibling origin. That boundary is documented where it is enforced, in
[`apps/lander/README.md`](../../../apps/lander/README.md).

## Why this could never be a merge

The two content trees look like near-duplicates and are not. Duet rewrote its
public copy off the old chat-centric product model — sessions, files, and
workspace history replaced channels, threads, and "the agent lives in your
chat" — so at discovery, every one of the 142 shared content files differed.
Almost none of that was missing work; it was Duet's own rewrite. Re-syncing a
shared file would have reverted it, and `verify:boundaries` would have rejected
the result anyway.

So the unit of porting was the hunk, never the file: take what chat-app
authored since the fork, leave every line Duet had already rewritten, and
restate each Duet claim inside the incoming prose in current terms. Any future
port from any predecessor should assume this shape rather than diffing trees
and trusting the result.

## What the gates could and could not see

This is the part worth carrying forward. Three classes of stale claim rode in
with the ported prose, in decreasing order of detectability:

**The copy gate sees vocabulary, not economics.**
`apps/lander/scripts/check-product-copy.ts` keys on channel/thread/chat terms,
so it caught the product-model claims immediately — eight of them. It is blind
to pricing: "tokens at cost, no markup, no per-seat tax", "unlimited seats", a
"$5 trial credit", a per-agent model picker, and internal tier ids like
"Balanced tier" all pass it cleanly while being false. More of those were found
by reading than the gate flagged. A ported paragraph needs a human pass on
every economic and capability claim, not just a green gate.

**Images carry claims no gate reads.** A routing diagram shipped with retired
tier names, an "at cost" bill, and superseded per-1M prices baked into the
pixels. Alt text cannot correct a picture, so it was dropped rather than
captioned around. Assume every ported diagram asserts something, and look at
it.

**A silently ignored prop loses attribution.** chat-app's `DuetCTA` took an
`href` prop; Duet's took `productPath`/`publicPath`. A ported post carried
`href`, React dropped the unknown prop without a word, and that button quietly
fell back to the generic campaign slug. Nothing failed. This is what drove the
CTA change below — a prop rename across a repo boundary has no compiler between
the two sides.

## The invariant the Spanish fallback creates

A post with no Spanish translation still renders under `/es` through the
English fallback, and its links get locale-prefixed. So **an English-only post
must not link to a route that builds for `en` alone** — anything under `/lp/`
— or the Spanish rendering 404s. The same shape bites redirects, whose sources
in `apps/lander/next.config.ts` are unprefixed and therefore English-only.

Neither is visible to a route-manifest gate, because every route the manifest
lists does exist. Crawling the built site against a running server is what
finds them; that crawl is what closed the last three.

## What this pass changed in the lander, and why

The plan told porters to translate product navigation into `productPath`. That
field no longer exists. All 161 of its uses in content — 144 in frontmatter, 17
as body props — were `/sign-in`, varying only in attribution query, so the
discriminator carried no information while letting a lander page be addressed
to the product host with nothing to catch it. Content now names a path and the site decides the origin
(`apps/lander/lib/blog/cta-href.ts`), with the route manifest and the product
path list forming a closed world that `verify:public-content` enforces. The
reasoning lives in the lander README under "Authored links name a path".

## Deliberately not ported, permanently

- **chat-app's public routes Duet lacks** — `/tools/ai-bill-audit`,
  `/tools/ai-cost-calculator`, `/lp/claude-code-cloud`, `/business-website`.
  Scoped out by Example User. They are ad entry points, not destinations: a full crawl
  of the built site confirmed nothing in Duet links to them, so their absence
  dangles nowhere.
- **The ad-attribution and conversion-tag wiring.** chat-app posts leads to
  `/api/leads` with GTM and Reddit conversion tags; Duet's lander owns
  `src/campaigns/` instead. The two rails have different shapes, so this was
  always translation rather than copying, and it was not worth doing for a
  source that is now frozen.
- **The SEO-pack post, its download bar, and the zip.** Dropped by Example User
  mid-port.

## Dead ends

- **The sitemap-diff tool** (`compare-sitemaps.ts` and its test) was kept
  alongside this spec to compare the lander against the incumbent `service.example.invalid`
  sitemap on request. That comparison's counterpart is a frozen v1 site, so the
  tool was deleted at close rather than left runnable against a dead target.
  Recover it from this spec's history if a live-sitemap comparison is ever
  wanted again.
- **Trusting a chronological cursor.** The plan already warned against it and
  was right: the fork point had to be re-established by inspecting both trees,
  because Duet's public extraction and chat-app's history do not share a commit
  graph.
