# Agent naming

Every agent's owner gets to choose its name — including the default agent's,
which is an agent like any other: same page, same rename, same token. Declining
to choose is allowed: a marketplace install then takes the listing's slug, and a
workspace that never named its default agent shows `Duet`.

Shipped 2026-08-07 to `origin/staging`. The decisions made along the way, and
the ones still open, are in [`choices.md`](choices.md).

---

## What this is

Four things that turned out to be one thing:

- Installing from the marketplace asks what to call the agent. It used to write
  the listing's *slug* into the display name, so a fresh install read
  `research-assistant` where the gallery had just said "Research Assistant".
- The `manage-agents` skill asks the user for a name before registering. The
  registration endpoint is open to any authorized caller, but that skill is how
  an agent creates an agent, so it is where the asking belongs.
- The drive root's agent can be renamed, at
  `PATCH /v1/ws/{workspaceSlug}/agents/root`.
- The drive root's agent has a detail page, at `/w/{workspaceSlug}/agents/root`,
  rendered by the canvas every other agent uses.

They are one thing because all four are answers to "what is this agent called,
and who decides".

## The reason

**A name is not a slug.** Every *registered* agent already had both — a path-safe
`slug` that URLs and folders use, and an optional free-form `name` that people
read
(`agentDisplayName` in `packages/backend/convex/domains/agents/model.ts` owns
`name ?? slug` on the server; `apps/web/spa/agents/agent-display.ts` carries a
deliberate browser counterpart, whose own comment records that a contract-level
display adapter was rejected because naming is presentation). The feature is not new machinery; it is closing the
gaps where the product forgot to *ask* for the name and then displayed the slug
instead.

**A marketplace name is per install, and permanently so.** A refresh moves the
subscription's own state — ETags, revisions, timestamps, errors — and rewrites
the contained `apps` rows. What it never touches is the agent row's `name`, or
the subscription's `agentName`, which is written once at insert and left alone
(see `createSubscription`, `syncContainedApps`, and `applyPullReportsImpl` in
`packages/backend/convex/domains/marketplace/model.ts`). So a rename survives every pull and ETag bump,
and a publisher renaming their own agent never reaches into your copy. This is
what makes asking at install meaningful rather than cosmetic, and it is pinned by
`packages/backend/src/marketplace.test.ts` — the test drives a real pull report
through the real apply path and asserts the name unchanged.

Share replicas are deliberately the opposite: `updateReplica` in
`packages/backend/convex/domains/agents/replication.ts` force-syncs `name` and `icon` from the origin on
every reconcile, which is why the `replica` menu shape omits Rename. If you ever
find yourself making shared agents renameable, that force-sync is what you have
to answer for first.

**The default agent has no row.** Its name is `workspaces.duetName`, and it lives
there only because the drive root has no `agents` row to carry one. That single
fact shapes most of the rest: the rename endpoint is agent-*shaped* but
workspace-*owned*; the endpoint answers with a bare `{name}` rather than an
`Agent`, because an agent-shaped response would mean inventing a row the product
does not have; and the detail page is told *which kind* of subject it is rather
than handed a fabricated agent.

**One token, `root`.** `ROOT_AGENT_SCOPE` (`packages/contract/src/sessions/index.ts`)
was already the wire value for session and job agent filters. Reserving `root` as
a slug is what made it safe to reuse as a route segment too — and once it was
safe, the knowledge map's private `DUET_ID = 'core'` had nothing left to buy. Its
own comment had said it existed because the map needed an id "that cannot collide
with a real agent's"; reservation is precisely that guarantee, so the second
vocabulary went away.

The payoff is visible in the smallest place: the root's New-session link is
`?agent=root` with no special case anywhere, because the reserved slug *is* the
scope token.

**Naming is offered, never demanded.** The install dialog opens every time — for
verified and unverified publishers alike, because consent is a decision about
*whose code runs* while naming is a decision every installer makes. But the field
starts empty with the listing's slug as a placeholder, and submitting blank omits
`name` entirely. The server then falls back to the slug, which is also what an
unattended campaign or signup install gets. One fallback rule, not two.

An earlier build required the name on the wire and preferred the listing's
*title* server-side. That needed a helper, an edge case for titles too long to be
names, and a seam where one field was required at the API and optional one layer
beneath. All three are gone.

## Invariants

Break these and something goes wrong quietly rather than loudly.

- **`agents.name` is the installer's, forever.** No marketplace refresh, pull,
  ETag bump, or app-declaration sync may write it. The subscription's `agentName`
  is a *different field* — the publisher's slug, what path and replay logic key
  on. If those two ever converge, a publisher's identity and an installer's label
  become one value.
- **Omitted means preserve.** `registerAgentImpl` patches `name`/`icon` only when
  the request carries them. Convex deletes a field patched to `undefined`, so the
  unconditional patch silently cleared a user's rename on any re-registration —
  and an agent following the `manage-agents` skill sends only what it is
  changing, which is exactly the shape that triggered it. There is deliberately no operation that clears
  a name back to the slug.
- **`root` is reserved in every namespace**
  (`packages/contract/src/slug/index.ts`). A contract test asserts the slug schema
  rejects `ROOT_AGENT_SCOPE` itself, so the bare literal in `RESERVED_SLUGS` and
  the exported constant cannot drift apart. The literal is spelled out rather than
  imported because importing it would make `contract/slug` depend on
  `contract/sessions`, which already depends on slugs.
- **A requested slug is refused; a derived slug steps aside.** Ask to publish at a
  reserved word and you get an error; publish a folder that merely *happens* to be
  called one and you get `root-2`, exactly as you would if the name were taken.
  `createPublishImpl` parses caller-supplied slugs up front so the stepping loop
  in `findAvailablePublishSlug` only ever sees proposals.
- **One display-name rule, 32 characters.** `AgentNameSchema` owns it and
  `WorkspaceDuetNameSchema` is an alias, so the two cannot diverge. The bound is
  short because the shortest surface decides: these names render in the knowledge
  map's centre label and the mobile header.
- **The default agent's rename writes workspace identity, never the agents list.**
  `useRenameDefaultAgent` patches the `whoami` cache. Patching the agents-list
  cache would appear to work and then silently revert, because the drive root has
  no row in it.
- **Routes do not join drive paths.** The drive root is the empty anchor, where
  `` `${anchorPath}/AGENTS.md` `` produces `/AGENTS.md` — which the file client
  sends as an *absolute* path, addressing a different file. `joinDrivePath` in
  `apps/web/spa/drive/agent-profile.ts` is the one owner; both the profile read
  and the README read go through it.

## Where the code is

| | |
|---|---|
| Display-name rule, request/response schemas | `packages/contract/src/agents/index.ts` |
| Reserved slugs | `packages/contract/src/slug/index.ts` |
| Install request schema | `packages/contract/src/marketplace/index.ts` |
| Slug fallback for an absent name | `createSubscription`, `packages/backend/convex/domains/marketplace/model.ts` |
| Rename mutations (both kinds) | `packages/backend/convex/domains/agents/model.ts` |
| Install → agent row | `packages/backend/convex/domains/marketplace/model.ts` |
| Public routes | `apps/api/src/routes/agents.ts`, `apps/api/src/routes/marketplace.ts` |
| Detail route + root branch | `apps/web/spa/routes/agents.tsx` |
| The shared canvas | `apps/web/spa/routes/agents/agent-detail-canvas.tsx` |
| ⋯ menu vocabulary | `apps/web/spa/drive/agent-roster-types.ts` |
| Install dialog | `apps/web/spa/marketplace/install-name-dialog.tsx` |
| Root-safe file reads | `apps/web/spa/drive/agent-profile.ts` |
| Skill guidance | `packages/skills-registry/skills/manage-agents/SKILL.md` |
| Live journey | `packages/test-harness/src/staging-e2e-synthetic` |

Tests that pin the behavior: `packages/contract/src/slug/index.test.ts` (the
reservation and its tie to `ROOT_AGENT_SCOPE`), `packages/backend/src/agents.test.ts`
(preserve-on-re-register, the default rename vs onboarding ordering),
`packages/backend/src/marketplace.test.ts` (the name survives a pull; the slug
fallback), `packages/backend/src/publishes.test.ts` (requested vs derived slugs),
`apps/web/spa/drive/agent-profile.test.ts` (root paths never leading-slash), and
`apps/api/src/index.test.ts` (route precedence for `/agents/root` — a
mutation-level test cannot see it, because a fallthrough would 404 on a slug no
agent can hold and nothing below the router would notice).

## Divergences from the plan

- **The dead roster nearly became the entry point.** Early recon read
  `buildRosterCards` and its `agent-roster-types.ts` header — which describes a
  rail rendered by an `agent-roster-rail.tsx` that is not in the tree — and
  concluded that was the live Agents surface. It is not; the live surface is the
  knowledge map (`apps/web/spa/routes/agents-map.tsx`), whose core now carries the
  detail and Train links it previously withheld. The error was caught during
  planning rather than during the build, so the plan carried the warning rather
  than the mistake. At close the dead projection, the card type
  only it used, and its test were deleted, and its live neighbour
  `agentMenuShape` moved beside the menu table it serves — so the comment cannot
  mislead the next reader the way it misled the first.
- **The publish slug allocator was broken, as the plan suspected but for a
  different reason.** It parsed each derived candidate with a throwing parser, so
  a reserved base aborted the loop rather than advancing. Fixing it forced the
  requested-vs-derived distinction above. That distinction is currently enforced
  only for publish slugs; nothing abstracts it across namespaces, so treat it as
  the precedent to follow rather than a rule the code imposes.
- **The install name became optional after the audit.** See "The reason".
- **Two name lengths became one.** The default agent's name reused
  onboarding's 32-character schema while registered agents allowed 64. Nothing
  explained the difference to a user who hit it, so the shorter rule won and the
  schemas were collapsed.
- **The live journey does not cover a publisher pull.** It would need a listing
  the journey controls; it owns none, so that property lives in the backend suite
  instead. The journey's docstring says so rather than implying coverage.

## Dead ends

- **Making every reserved slug step aside.** A working version of the
  `findAvailablePublishSlug` fix treated a caller-requested `api` the same as a
  derived one and silently renamed it to `api-2`; the existing reserved-slug test
  in `packages/backend/src/publishes.test.ts` failed and it never landed. (That
  attempt is not in history — it is recorded here because the test that killed it
  is the only surviving trace.) A request deserves an answer; only a proposal may
  be quietly replaced.
- **Preferring the listing's title for unattended installs.** Sound-looking and
  strictly worse: it created a second default rule, an edge case for overlong
  titles, and two requiredness rules for one field.
- **Twelve `agent!` assertions in the detail route.** TypeScript cannot infer that
  "not the root" implies an agent was found, so the first version asserted it
  twelve times. The route now resolves a discriminated subject whose absence *is*
  the not-found case.
- **A per-agent model tier**, considered and dropped before any code — so the
  reasoning survives only here. The constraint
  that decides its shape, if it returns: `agent.json` is drive content and Convex
  cannot read it — `resolveAgentConfig` is called only by the gateway and the
  browser, while `resolveSessionTier` runs in
  `domains/agentSessions/delivery.ts`. An authored-only field could never reach
  the resolver. Related: `PUT /default-model` is the floor of
  `requested → sessionLast → workspaceDefault → planDefault`, not the root
  agent's setting, and does not belong under `/agents/root`.

## Visual provenance

No reference or inspiration image is checked in for this work; the standard it
was held to was internal consistency. The default agent's page had to read as *the same page* as a
registered agent's, and the install dialog had to read as an offer rather than a
demand. Both were judged by unprimed critique, and both critiques are kept here
because they *are* the standard the result was held to:

- [`assets/root-detail-critique.md`](assets/root-detail-critique.md) — the drive
  root's page beside a registered agent's, shown to a reviewer with no context.
  Its opening line ("they clearly share the same page design; most differences
  are data-driven rather than structural defects") is the verdict the work
  needed, and it identified the header difference as deliberate unprompted. Every
  "Both" finding it raised is pre-existing on the registered-agent page and is
  triaged in the file.
- [`assets/install-dialog-critique.md`](assets/install-dialog-critique.md) — the
  install dialog at both viewports. One finding was the feature's own copy and
  is fixed (the mobile subtitle orphaned "any time." on its own line); the other
  three describe the shared `Dialog` and `Button` primitives, which other dialogs
  in the app render the same way.

The committed baselines are the record of what shipped:
`apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/agent-detail-root.png`
(the default agent on the shared canvas) and `.../marketplace-install-name.png`
(the install dialog, empty with the slug as its placeholder).

Note that the install-dialog critique predates the final copy: it was run when
the field was pre-filled with the listing title, before the audit turned naming
into an offer. The orphaned-subtitle finding it caught is fixed in the shipped
baseline; the dialog it describes is one revision behind.
