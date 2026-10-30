# Public lander

This app is the sole owner of Duet's anonymous marketing, editorial, campaign,
legal, install, public-form, and SEO surfaces. Its production output is static
and URL-owned: locale preference may influence navigation, but never the HTML
rendered for a public URL.

`https://duet.so` is the sole production canonical. The legacy
`https://lander.duet.so` host permanently redirects to the same path on the
canonical domain; staging remains `https://lander-staging.duet.so`.

The product is a sibling origin, not a route inside this app. Product links go
through the origin helpers in `src/config/origins.ts`; cross-host browser policy
comes from the dependency-free web-locale package. Auth, browser sessions, and
internal admin are forbidden dependencies. The one server-side product seam is
`src/campaigns/`, which owns anonymous campaign actions end to end and talks to
Convex directly with the internal key; page rendering stays static and
Convex-free.

Use the scripts in `package.json` to verify its static output, content, visual
coverage, and ownership boundaries independently from the product app. Static and
SEO checks cover every concrete public URL; screenshots cover every distinct page
template plus two rich blog bodies, not every generated post or tag URL.

`/playground` is the menu of lander building blocks — chrome, section, demo,
and atom fixtures rendered in isolation and deterministically
(`app/playground/registry.ts` is the metadata, `render-map.tsx` the only JSX
map, and the shell owns readiness). The visual gate screenshots every entry on
desktop and mobile, and the coverage ledger lets a fixture own a component's
whole import closure, so representative page routes can churn freely while the
building blocks stay pinned. The route is noindexed and robots-disallowed but
ships in the build, because the Docker gate photographs the optimized artifact.

A fixture is the only way to pin anything below the fold: route baselines are
captured at viewport height, not full page, so that growing editorial pages
cannot make Git history unbounded. A section far enough down its page is
therefore not loosely covered by its route — it is not covered at all.

## One indexed lander, and every other pitch under `/l/`

`/` is the only whole-page pitch a crawler is meant to find, and it sells one
deal: one subscription that puts every kind of state-of-the-art AI in reach of
someone who will not set it up themselves. The audience and the messaging
rules live in [positioning](../../positioning.md). `/es` is the same page in Spanish, not a second pitch. All of its
words, in both languages, live in `landers/home-copy.ts` (the metadata, the
JSON-LD in `lib/seo/home-json-ld.ts`, and the agent-readable twin read them
from there too), and every capability it names has a caller in the product.
Every other pitch —
the platform overview, the agent-cloud and file-sharing pages, each audience
pitch — lives at `/l/<slug>`: EN-only, `noindex, follow`, absent from every
sitemap, and never linked from the nav or footer. The prefix is what makes that
enforceable, because one `startsWith` covers the blanket noindex and the
never-linked check; a second indexed lander would split authority with `/` and
freeze copy we want to iterate weekly.

They do wear the site's nav and footer, which the paid-traffic rulebook would
call a leak — every outbound link is an exit before the CTA. That is a
deliberate override: one site, one chrome, and a lander that looks like a
different product costs more trust than the exits cost conversions.

Two kinds of lander share the prefix and the audience cannot tell them apart,
so the wiring does not either. `components/landing/campaign/campaign-spec.ts`
names every slug: a **template** lander is pure copy the shared
`CampaignLanding` renders, and a **bespoke** one owns its sections and its
animated proof, mapped from slug to component in `campaign-render-map.tsx` —
the same metadata-plus-one-JSX-map split the playground uses, and for the same
reason (the route's metadata and the public route manifest read the lineup
without importing a lander).

Onboarding is self-serve, so every lander makes one ask at each end: a
configured product-origin `/sign-in` link with an attribution query. The
navigation and every editorial CTA use the same product-origin helper, so a
visitor can start signup from any public page.
The campaign signup action under `src/campaigns/` still mints attribution and
hands off to the product for the lead-capture forms that call it; that is a
GET with a side effect, so it must never be prefetched, and `PrimaryCta`
decides that from the href rather than from a prop each caller has to
remember. A slug with no row in the Convex campaign registry answers 404
from that action, so a new lander is one entry in the spec plus one row
there.

The hero and the closing ask live in `hero-and-close.tsx`, apart from the
section library, because every lander mounts both and picks its sections: a
page reaching for the frame should not pull the whole proof catalogue with it.
Anything a second lander reaches for moves into the shared library rather than
being imported across from another lander's own `<page>-sections.tsx`.

## Authored links name a path; the site decides the origin

Content never writes an origin. A post's CTA, a `ProductLink`, a markdown link
— each names a path, and `lib/blog/cta-href.ts` decides whether it stays
relative or resolves against the product. The point is that authors cannot get
it wrong: the lander's route manifest and the short product-path list together
form a closed world, so `verify:public-content` fails the build on a target
that belongs to neither. An open world here is silent — a lander page written
as a product target 404s on a host nobody checks.

Public copy that states a product fact derives it from `@repo/contract` rather
than restating it (`lib/public-site-config.ts`). Marketing that hand-copies a
tier, a plan price, or a model set drifts the moment the product changes, and
nothing turns red. Tier token rates are never public copy: they are internal
pricing, so the public tier ladder does not carry them.

## The agent-readable site is the same site, rendered from the same sources

`lib/llms/` owns `/llms.txt`, `/llms-full.txt`, and a `.md` twin of every page.
None of it reads built HTML. An article's twin comes from its MDX file, a
vertical's from `verticals-spec.ts`, a use-case leaf's from `use-cases-spec.ts`,
pricing's from `@repo/contract` — the same owners the pages themselves render
from, so a twin cannot decay into a worse copy of the page it mirrors.

Which pages exist is asked of the sitemap shards rather than listed again. The
shards are already the curated answer to "which English URLs are real,
indexable content": they exclude the noindexed trees and the discontinued
Spanish marketing tree on purpose. A second list would be a second thing to
forget, and an llms.txt that disagrees with the site is worse than none.

The index carries the product explanation inline, which looks like duplication
until you read `app/robots.ts`: AI crawlers are disallowed from everything
except a few reviewed prefixes. A model that obeys robots.txt reaches
`/llms.txt` and little else, so a bare list of links it may not follow teaches
it nothing. That is also why adding a public surface for agents means adding it
to `AI_ALLOW` — otherwise it ships unreadable by the only audience it has.

## A twin that 404s correctly is a routing accident away from a 500

`/<route>.md` is rewritten in `proxy.ts` to `/md/<route>`, and the handler
there must **not** set `dynamicParams = false`. With it, an unmatched param
makes Next treat the route as not matching at all and fall through to
`app/[locale]/...`, which renders the twin as a localized page with `md` as the
locale — that throws inside the landing specs and serves a 500 where the site
meant "no such page". Unit-testing the handler cannot see this; it only appears
through the real router, which is what `verify:build-output` now checks.

## Decoration is not allowed to unmount the document

A WebGL scene that cannot get a GL context does not degrade — it throws, and a
throw while mounting takes the entire page with it, because nothing here
catches it. So a client with no GPU gets the browser's "this page couldn't
load" in place of the site: not a missing background, the whole document. That
client is usually a scraper or an agent's headless browser, which is to say the
readers this app most cares about after humans.

Every WebGL mount is therefore gated on `useHasWebgl` (in
`components/landing/atoms.tsx`) rather than left to discover the answer by
throwing, and the sections that lead with a scene own a DOM telling of the same
story — the train section's switcher is the phone layout and the GL-less layout
at once. `three` gets a `try`/`catch` on top, because a GPU process can die
between the probe and the mount.

`public-no-webgl.spec.ts` stubs `getContext` to `null` and loads the scene
pages; the screenshot suites cannot see any of this, because the container they
run in has WebGL.

## A page that exists only in English can 404 a link that works

Two traps share one shape, and both fire only on `/es`. A post with no Spanish
translation still renders under `/es` through the English fallback, so its
links get locale-prefixed — and a target that builds for `en` alone (any
`/l/<slug>` lander) has no `/es` twin to land on. Separately, `next.config.ts`
redirect sources are unprefixed, so a moved page redirects in English and 404s
in Spanish.

Neither shows up in a gate: the route manifest is happy because every route it
lists exists. Crawling the built site against a running server is what finds
them.

## The display face is fetched at build time, so baselines drift on their own

`app/layout.tsx` loads the body and mono faces with `next/font/local` but the
display face with `next/font/google`. That one import makes the build depend on
whatever version Google is serving: when the upstream font changes, its metrics
change, text re-wraps, and every full-page screenshot shifts by tens of pixels
at once. The content is identical — only the glyphs moved — so it reads as mass
visual failure with no diff you can point at.

Recognising it is the hard part, and the tell is which apps break: the product
app uses only `next/font/local` and never drifts, so a sweep that reds the
lander and the docs site while leaving the product green is this, not a
regression. Confirm by checking that the woff2 files are present under `.next`
— if they are, the font was fetched and merely differs, and re-approving the
baselines is correct. If they are absent the build could not reach Google and
fell back, which is a different failure with the same symptom.

Self-hosting the display face would pin it and remove a network dependency from
a regression gate. That trade — vendored font binaries against a suite that can
turn red without a commit — is open, not decided.
