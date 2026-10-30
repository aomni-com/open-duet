# The new lander lineup — working draft for messaging iteration

Target: **one main lander + 3–5 campaign landers**, each campaign lander an
alternate main lander for one audience, wired to a campaign slug that tags
signups through onboarding (starter agents, conversion events). Ads are fully
stopped, so nothing constrains the copy — every headline below is a proposal
to be beaten, not a decision. Raw material: [MESSAGING.md](MESSAGING.md).

## SUPERSEDED 2026-10-18 — `/` sells one subscription for every kind of AI

The consultant pitch is gone from `/`. The homepage now sells the frame in
[positioning.md](../../positioning.md): one subscription, every kind of AI, no
setup, for the AI-curious who will pay to be at the state of the art but will
not assemble it. The page shows what the state of the art includes (jobs to
hand over, the stack those jobs replace, the built-in inventory, sharing
anything with anyone) and keeps engineering words off it. The consultant deal
is one use case of that frame; `/l/sell` remains its paid-traffic variant.

## SUPERSEDED AGAIN 2026-09-09 — `/` sells the consultant deal

The Webflow/Wix switch pitch is gone from `/`. The homepage now positions Duet
for consultants and agencies who build agents for their clients: build the
agent once, run it for every client, keep the agent quality and hand off the
infrastructure. It reuses the shared pillars, train, share, platform, and
integrations sections; `home-sections.tsx` (replace, shipped wall, live demo,
benefits) was deleted with it, along with the rollback and custom-domain
claims the product does not back. Onboarding is by call, so every CTA books
one. `/l/sell` remains the paid-traffic variant of the same audience.

## SUPERSEDED 2026-08-20 — the platform lander is no longer `/`

Example User's call, after the platform lander had been live for five days: the main
lander sells **one switch**, not the platform. `/` is now the build-and-host
lander (formerly the `/app-hosting` product page), rewritten to name Webflow,
Wix, and HubSpot sites explicitly and to argue the five reasons to leave them
— more powerful, more control, build whatever you want, no dev shop to wire
in, thousands a month back. A named competitor converts where a category does
not.

Everything else in the lineup collapsed under `/l/`:

| URL | Was | Kind |
|---|---|---|
| `/` | `/app-hosting` product page | the one indexed lander |
| `/l/platform` | `/` (the platform lander below) | bespoke campaign lander |
| `/l/agent-cloud` | `/agent-cloud` product page | bespoke campaign lander |
| `/l/file-sharing` | `/file-sharing` product page | bespoke campaign lander |
| `/l/team`, `/l/business`, `/l/sell` | unchanged | template campaign landers |
| `/l/build` | — | **deleted**; its pitch is `/` now |

Three further decisions taken with it:

- **The product-page tier is gone.** `/agent-cloud`, `/app-hosting`, and
  `/file-sharing` 404 with no redirect (Example User: "delete it — let it 404"), and
  the footer's Product column no longer links them. The 2026-08-15 decision
  that made them indexed product pages is reversed: one indexed lander, and
  everything else is paid-traffic surface.
- **Every page wears the same chrome** (Example User). The minimal campaign
  header/footer is deleted; `/l/*` now renders the site nav and the full
  footer like every other page. This reverses "minimal chrome" in the ground
  rules v2 below — brand consistency won over leak-proofing paid traffic,
  the same trade already made for the video hero.
- **`/` keeps its direct CTA.** Campaign landers mint attribution through
  `/api/campaigns/<slug>/actions/signup`; the main lander does not, so the
  site's highest-traffic conversion does not depend on a Convex round trip.
  Open consequence: signups from `/` install the default starter agents, not
  the website/landing-page set the page promises. Worth revisiting if the
  first-run experience reads as off-message.

## Main lander (HISTORICAL) — the PLATFORM lander, `/` until 2026-08-20

Direction (Example User): the main lander sells the platform; every campaign page
under `/l/` is a specific use case of it.

### Hero

- **H1:** Create and share agents with your `team → customers → business`
  (rotating bracket; static "team" fallback for reduced motion / no-JS)
- **Subhead (DECIDED — warm):** Duet is the platform your agents live on —
  every frontier model, a real always-on computer, a browser of its own, and
  the tools your business already runs on. Build an agent in minutes. Share
  it like a doc.
- **CTA:** Start free · Free to start · No credit card

### Section 1 — "Everything a modern agent needs, built in"

The primitives, as cards. Numbers and model names derive from
`@repo/contract` at build time, never hand-written.

- **Every frontier model, one gateway** — Claude, GPT, Kimi, and the rest of
  the frontier behind one gateway. You pick a quality level, not a model
  name: Duet routes each task to the strongest model for it and re-decides
  as the work changes. One flat rate whichever model answers.
- **A real computer, not a sandbox** — every workspace is an always-on
  machine: 8 cores, 16 GB of RAM, up to 100 GB of storage. It persists —
  files, memory, running work — and keeps going when you close your laptop.
- **A browser of its own** — your agents click, type, log in, and act on the
  real web, not just read it.
- **Install anything** — it's a full computer, so agents install and run
  what an employee would: WhatsApp, Slack, a CLI, whatever the job needs.
- **Services on tap** — image and video generation, contact, email, and
  social data sources, and more through one built-in service gateway. No
  API keys to wrangle, one bill.
- **A team of agents, not one** — define as many agents as the work needs,
  each with its own memory, skills, and instructions.
- **One workspace, everyone in it** (DECIDED — workspace + multiplayer
  merged) — files and shared memory every agent reads and writes, and
  teammates working in the same sessions as the agents: every run visible,
  every edit attributed. Share a folder and people and their agents inherit
  the same context under the same rules.
- **Schedules and triggers** — agents run on a schedule, wake on events, and
  work while you sleep.
- **Ships real apps** — whatever an agent builds goes live at a real URL,
  hosted from the workspace, the moment it's finished.
- **Self-driving** (the capstone, last card) — agents hold the same platform
  API you do. They start their own sessions, spin up new agents, hand work
  to each other, set their own schedules, install their own skills — anything
  you can do on the platform, your agents can do. You describe the outcome;
  the platform runs itself.

(Ten cards. One optional further fold if the section runs long in the
build: Schedules into the computer card.)

### Section 2 — "Bring your agents. Connect your tools."

Two rows, mechanism stated only as consequence:

- **Your agents plug in** (via MCP): Claude Cowork, Claude Code, ChatGPT,
  Codex, Cursor — point them at your workspace and they get its files,
  memory, and skills. Duet doesn't replace the agents your team loves; it's
  where they work.
- **Your tools connect** (via Composio): Gmail, Google Drive, OneDrive,
  Outlook, Notion, Slack — and the long tail of work tools. Agents act in
  the tools your business already runs on.

### Section 3+ — carry-overs and the share story

- **Share section** (the hero's verb, paid off): share an agent with your
  team like a folder; publish one to customers through the marketplace.
  This is the section the [customers] bracket word points at.
- Keep from today's page where they fit the platform frame: the train-your-
  agent section, realtime co-editing demo, FAQ frame. The silo-shelf problem
  section may retire or move to the `team` campaign page — it argues one use
  case, not the platform.
- **Agent-team visualization** (salvaged, in the playground as
  `lander-agent-team`) is a candidate hero/section visual: it shows named
  agents working sessions in parallel — exactly section 1's promise.

## Campaign landers — BUILT 2026-08-15 (Example User's final four)

The shipped set diverges from the draft below (kept for the copy archive):
**team** (consolidate AI usage; centralized repo for memories, skills,
integrations, internal apps), **business** (AI runs marketing, sales, ops,
engineering), **sell** (package your expertise + agentic OS, deploy to the
small businesses you serve), **build** (the app builder that builds, runs,
then markets and sells the app). `uncapped` was cut. One template at
`app/[locale]/l/[slug]` driven by
`components/landing/campaign/campaign-spec.ts`; Convex registry rows carry
per-audience starterAgents.

## Campaign landers — original candidates (pick 3–5)

All: `/l/<slug>`, `robots: noindex, follow`, never nav-linked, CTA carries
the campaign slug through the signup action, Convex campaign entry with
`starterAgents` tuned to the audience so onboarding installs the right
agents on arrival.

### 1. `team` — "your team" expanded

Audience: teams already paying for Claude/ChatGPT seats. The sharpest
archived asset (agent-drive + shared-login + small-team all circled it).

- **H1 options:** "Ten AI seats. Zero shared memory." / "Your team's agents,
  finally on the same team." / "Three people. Six agents. The output of
  twenty."
- **Promise:** one workspace where every agent shares the company's context —
  what one learns, all know. Assign work to a person or an agent from the
  same place; every run visible, no shared logins.
- Starter agents: collaboration/research/ops set.

### 2. `business` — "your business" expanded

Audience: SMB operators, paid search. The ai-employee lander was built for
exactly this traffic and its frame held up.

- **H1 options:** "Hire an AI employee that actually does the work." /
  "Create the employee you can't afford to hire." / "Your business, running
  while you sleep."
- **Promise:** brief it like a hire — bookkeeping, outbound, support,
  reporting — it does the job end to end, 24/7, no code.
- Starter agents: bookkeeping/outbound/support/reporting set.

### 3. `sell` — "your customers" expanded

Audience: experts and creators with an audience. scale-your-expertise had
the most precise copy of the old set; it becomes real now that agents are
shareable/marketable products.

- **H1 options:** "Sell what you know, not the hours you have." / "Create an
  agent your customers can hire." / "Your method, packaged once, sold a
  hundred times."
- **Promise:** teach an agent your method in plain language; share or sell
  it to the audience you already have; customers get results, never the
  recipe.
- Starter agents: authoring/packaging set + marketplace publish flow.

### 4. `uncapped` — the power-user wedge (optional but proven)

Audience: Claude Max / Codex power users. The reddit set's most specific,
highest-resonance pains (rate-limits, laptop-lid, multi-model) — and the
only angle aimed at people who already run agents daily.

- **H1 options:** "You pay $200/month for Claude. You still get rate
  limited." / "Your agent shouldn't die when you close your laptop." /
  "Claude AND Codex. One workspace. No caps."
- **Promise:** agents on the API on an always-on server — parallel, uncapped,
  resumable from any device.
- Starter agents: dev/research set.

### 5. `builders` — recommend CUT for now

The headless-agents angle (agents for clients on isolated backends) promised
infrastructure that doesn't exist as a product surface today. Fold its
audience into `sell` until there is something real to land on.

## Ground rules v2 (from the best-practice review)

- Campaign landers get **minimal chrome**: logo + one CTA, no site nav, no
  link-grid footer (legal links only). Every outbound link is a leak on paid
  traffic.
- Message match runs **through onboarding**: the campaign slug already picks
  starter agents; the onboarding copy should echo the campaign promise too.
- Campaign landers are **static text/image heroes** — no full-viewport video;
  LCP is a conversion input on paid traffic.
- Decide per-lander conversion readout (lead → signup → purchase per slug is
  already recorded by the attribution rail) before the first ad spends.
- DECIDED (Example User): /agent-cloud, /app-hosting, /file-sharing are **product
  pages** — indexed, sitemapped, llms-twinned, linked from the footer's
  Product column. A header Product dropdown (mirroring the use-cases
  mega-menu) should land with the new-hero nav design in the lineup build.

## Wiring contract (per shipped lander)

1. Route `apps/lander/app/[locale]/l/<slug>/page.tsx`, EN-only,
   `dynamicParams = false`, noindex.
2. Convex `campaigns` entry: `enabled`, 30-day window,
   signup+purchase conversion, `starterAgents: [...]`, destinations
   explicit-disabled until ad credentials exist.
3. CTA → sign-in via `/api/campaigns/<slug>/actions/signup` (attribution +
   journey cookie already work); lower-page lead capture posts
   `actions/lead` with `pageSlug: <slug>`.
4. Visual + route gates pick the page up from `ENGLISH_STATIC_PATHS` in
   `src/public-route-manifest.ts` — one list to edit.
5. Staging journey: one campaign lander journey in `packages/test-harness`
   covering signup-with-attribution → onboarding starter-agent install.

## Build record — the final four (2026-08-15)

Two unprimed screenshot-critique rounds (desktop+mobile full pages + zoomed
crops) drove the polish pass; all confirmed defects fixed, verdict SHIP:

- Hero italic tail is now a block element: the second sentence always starts
  its own line, so no mobile wrap strands its first word mid-line.
- Trust bullets fit one line on 390px (`gap-x-4 sm:gap-x-6`).
- `same AI.` / `and consultants` joined with non-breaking spaces.
- Shared-component fixes that also improve the homepage: FacetPanel remounts
  when reduced-motion flips post-hydration (was frozen invisible for
  prefers-reduced-motion users — content loss), and the train demo card
  occludes orbiting chips (z-40 + backdrop blur; a chip crossing the panel
  used to wipe out a filename row — proven fixed with an rect-intersection
  probe capture).

Left deliberately: build page is one section thinner than its siblings (no
borrowed proof section fits its story — content call if it underperforms);
sell page reuses ShareSection, which Example User removed from the homepage but is
squarely on-message for selling agents.

## Hero consistency (Example User, 2026-08-15)

Campaign landers share the main lander's chrome: the same video hero
(`LanderHero`, one owner in home-sections), the TrustedBy band under it,
and the shared `FinalCta` closing with the book-a-call link. This is a
deliberate override of the rulebook's static-hero default for campaign
pages — brand consistency won over hero LCP. Revisit only if paid-traffic
conversion shows the video hero costing us. The campaign audience tag
renders in the hero's chip slot (where home shows the fundraise chip).
