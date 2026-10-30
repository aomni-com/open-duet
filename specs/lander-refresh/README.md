# lander-refresh — start the lander lineup over

Goal: end with **one main lander** (hero direction: "Create and share agents
with your [team, customers, business]") **plus 3–5 campaign landers** with
very precise messaging, each linking to a campaign slug we can tag through
onboarding. Messaging iteration comes first; [MESSAGING.md](MESSAGING.md)
archives every deleted lander's copy verbatim as the raw material.

## State after the 2026-08-14 teardown

Deleted (routes, components, logic, baselines — no redirects, no compat):
`/lp/agent-drive`, `/lp/ai-employee`, `/grow`, `/scale-your-expertise`,
`/headless-agents`, `/summer-of-tokens` (+`/apply` + its API route), all ten
`/from/reddit/*` pages, the growth-brief scan pipeline (`src/campaigns/
growth-brief*`, the `scan` campaign action, the `CampaignScan`/`GrowthBrief`
contract schemas), the whole `components/landing/campaigns` dir, the Convex
`grow`/`scale-your-expertise`/`headless-agents`/`agent-drive` campaign
entries, the fit-classification conversion rail (`classifyFit` +
`fitClassifier` + tests) that only `grow` carried, and the
`campaign-conversions` staging journey. All of it is recoverable from git and
the rationale records under `specs/done/` if a real campaign wants a piece
back.

Kept and untouched: the SEO trees (`/for/*`, `/use-cases/*`, `/vs/*` — the
nav links `/use-cases`, nothing links the deleted pages), the feature landers
(`/agent-cloud`, `/app-hosting`, `/file-sharing`), blog/guides/pricing, and
the anonymous lead + signup attribution rail (`src/campaigns/actions.ts`,
`/api/campaigns/<slug>/actions/lead|signup`, Convex `domains/campaigns`).

The EN homepage `/` still renders the agent-drive lander (`AgentDriveLanding`,
capture slug `main`) — it IS the current main lander until the new hero
replaces it. The Spanish homepage is a separate older lander (`homeCopy`),
out of scope here.

## Decisions taken during the teardown

- **No backward compat anywhere** (Example User's call): deleted routes 404 — no
  redirects for old ad links; the Convex campaign registry keeps only slugs
  with live capture surfaces (`organic`, `main`, `agent-cloud`,
  `app-hosting`, `file-sharing`).
- Shared pieces rescued from deleted files: `InkMark` →
  `components/landing/ink-mark.tsx`, `useIsDark` →
  `components/landing/use-is-dark.ts`, `faviconUrl` inlined into
  `components/blog/email-capture-form.tsx`.
- The dead `forceLight` rail (LandingChrome/LandingNav prop + `lv2-force-light`
  CSS) was removed, and `components/landing/lp/` was renamed to
  `components/landing/landers/` so nothing is named after the dead route
  prefix.

## New-lineup ground rules (agreed direction)

- Campaign landers are **alternate main landers**: never linked from the
  nav/footer, `robots: noindex, follow` (they exist for paid/targeted traffic;
  indexing them splits authority and locks copy we want to iterate freely).
- Each campaign lander gets its own campaign slug in
  `packages/backend/convex/domains/campaigns/config.ts`; its CTAs carry the
  slug through the existing lead/signup attribution rail so onboarding can
  tag by campaign (`onboarding.starterAgents` per campaign already works).
- URL shape: keep a `/lp/<slug>` prefix. Ad platforms don't care about URL
  aesthetics, and the prefix buys mechanical guarantees: blanket noindex, a
  closed world the route-manifest gates can assert "campaign pages are never
  nav-linked / never sitemap'd" over, and zero collision risk with real
  marketing pages.

## Next

The 2026-08-15 lineup shipped and was then re-cut on 2026-08-20 — see the top
of [LINEUP.md](LINEUP.md) for what `/` sells now, why the product-page tier
was deleted, and the two ground rules that decision reverses. The lineup
itself is settled; what is open is copy performance on the new `/`, and
whether signups from it should carry the campaign rail's starter agents.
