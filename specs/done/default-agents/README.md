# Default Agents

The official catalog: role-shaped agents that ship with the product (21 at
close, and the roster is expected to grow), seeded
from this repo into the official hub and installable from the marketplace. It
replaced three placeholder agents that were five lines of prose advice each.

An agent is a folder — `AGENTS.md`, `agent.json`, agent-local skills under
`.agents/skills/`, and optionally apps under `apps/`. The bytes in
`packages/official-agents-seed/content/agents/` are the source of truth; a
generated module carries them into the API, which pushes them to the hub VM.

## The reason

**Why a repo package and not hub authoring.** An official agent is code-owned:
it is reviewed, tested and versioned like code, and a rename or a prompt fix
ships through the same gates as a schema change. Hub authoring would make the
catalog a database with no review surface. The cost is that the hub becomes a
replica that can drift — see the invariants below.

**Why tags live in `agent.json` and not in the manifest.** The manifest was the
cheaper option only while official sync kept its own metadata path. Once
official listings went through `deriveListingMetadata()`, tags cost one snapshot
field and a few inspector lines — and third-party publishers got tagging for
free rather than needing a second mechanism.

**Why `tags` parses as `z.array(z.string())` and not the closed enum.** This is
the trap worth remembering. `AgentConfigSchema` is `.loose()`, and its contract
is that *declared fields validate hard*. A declared enum means one unknown tag
throws, `resolveAgentConfig` catches, returns the unreadable-config fallback,
and the agent **silently loses its entire `onboarding` block** — an agent that
should be locked behind a connection becomes unlocked and inert. So the field
parses permissively and the closed vocabulary (`AGENT_TAGS`) filters in the
projection. Unknown tags drop harmlessly.

**Why an app is optional.** A decorative app is worse than no app. The three
placeholder agents' apps were posters of their own skill files and were deleted.
Six apps ship across five agents, and each is either a live board the agent
drives through the app's own HTTP API or an onboarding picker.

**Why finance is absent.** Scope call, deliberate: no tag, no agents.

## Principles and invariants

**Under a managed root the repo is the whole truth — files and registrations.**
`manifest.ts` decides which roots are managed; inside one, a sync reaps files
the plan no longer claims and retires app rows it no longer declares. It is a
diff, never a wipe: identical bytes are never rewritten, because the publish
ETag is stat-derived and a needless rewrite would push a full re-download to
every subscriber.

Two bounds make that safe. The publish floor (`node_modules`, `.git`,
`.duet-anchor`, `.env*`) is never reaped — the last of those is the marker whose
absence makes the gateway refuse the folder as a hijack. And a root the plan
does not name is never walked, which is what keeps demotion working.

This shipped after renaming Website Builder's ten skills left the hub serving
twenty, with the listing card looking correct the whole time because its
metadata derives from the repo's bytes rather than the hub's.

**Dropping an agent from `manifest.ts` is demotion, not deletion.** It stops
being managed and keeps serving its last bytes. There is no delete operation and
none should be built.

**When deleting hub folders by hand, scope by Convex deployment.** The exe
account is shared between staging and prod; a pattern-matched sweep reaches into
the other environment's drives.

**One derivation, two snapshot producers.** The gateway inspector (remote
folders) and the seed package (in-process bytes) produce the same
`ListingOriginSnapshot`, and both feed `deriveListingMetadata()`. That is not two
owners. A third producer is the smell.

**Registration is idempotent and reports what it did.** `POST /v1/ws/{slug}/agents`
returns `apps: [{ slug, path, status }]` with `created | updated | unchanged`,
reflecting the row's real slug — a collision-suffixed slug included. Registering
an agent registers its declared apps; any other behavior is a bug.

**Registration heals the anchors it names.** An anchor ties a VM folder to a
database row, and the gateway refuses to serve a folder whose marker is missing.
Deleting an agent's folder destroys the marker, so register re-anchors the
agent's own path and each declared app's — and nothing else. Registration
vouches for what it declares.

**Terminal states never answer "provisioning".** Gateway resolution returns a
typed refusal, and the vocabulary is defined by transience: `provisioning` (409)
only for states that clear on their own, `paused` (402), `archived` (410, the
code this API already uses for a thing that existed and is gone). `null` — which becomes 404 — covers
both genuine absence (deleted, retired) and states the caller may not be told
apart from absence (suspended, banned): those workspaces exist, and answering
404 is deliberate rather than a naming accident. What `null` must never mean is
"still starting up".

## Single owners

| Concept | Owner | May never own it |
|---|---|---|
| Tag vocabulary | `AGENT_TAGS` / `AgentTagSchema` in `@repo/contract` agents | seed manifest, backend literals, any *untyped* UI list (a `Record<AgentTag, …>` label map is fine — it cannot drift without a compile error) |
| `agent.json` parsing | `resolveAgentConfig()` in contract agents | gateway inspector, API routes, seed tests |
| Listing metadata derivation | `deriveListingMetadata()` in contract marketplace | official sync, Convex catalog query, gallery |
| Origin snapshot production | gateway inspector **and** seed package — same output type | anything building `derived` by hand |
| Seed roster | `packages/official-agents-seed/manifest.ts` | tests, API route, backend, staging journey |
| App registration | `registerAppImpl` in `domains/apps/model.ts` | agent registration, marketplace install, admin |
| Gateway refusal → HTTP | the refusal table in `apps/api/src/gateway/client.ts` | individual routes |
| App state format | each app's own module | `@repo/contract`, backend, gateway, skill prose |
| Catalog filter semantics | `apps/web/spa/marketplace/tag-filter.ts` | gallery card, backend query |

## Authoring

`packages/official-agents-seed/AUTHORING.md` is the binding quality bar and the
document to read before writing an agent. It carries the two admission rules (a
role not a task; not something the product already is), the four required parts
of an `AGENTS.md`, the file-form test for when a connection is genuinely
required, and the onboarding-page house style.

The rule that costs the most when broken is **every agent stands alone**: a user
installs one card, so an agent may not reference another agent, may not carry
catalog-level rationale, and must deliver its user story end to end with its own
skills in a workspace where nothing else exists. Scope that stops an agent short
of its own story is a gap, not scope. Nothing enforces this — `seed.test.ts`
checks structure (required sections, a prompt floor, derivable metadata), not
whether a prompt gestures at a colleague. It is a review rule and needs a
reader.

Two things there are quietly catalog copy and cost the most when missed: the
**first paragraph of `AGENTS.md`** becomes the listing summary, and **skill
directory names** appear on the card — first two, alphabetically.

## Pointers into the code

- **Content and manifest** — `packages/official-agents-seed/content/agents/`,
  `manifest.ts`, generated into `src/content.generated.ts` by `bun run codegen` **from that
  package** (it is not a root script, unlike `try` and `e2e:staging` below).
  `seed.test.ts` fails when the generated module is stale.
- **Sync plan** — `buildOfficialSyncPlan()` in `packages/official-agents-seed/src/index.ts`;
  `officialListingOrigins()` builds snapshots from the generated bytes.
- **Hub write** — `POST /v1/internal-admin/official-hub/sync` →
  gateway `/converge-subtree` → Convex `completeSync`.
- **Tags** — `AGENT_TAGS`, `MAX_AGENT_TAGS`, `resolveAgentTags()` in
  `packages/contract/src/agents/`; filter UI in `apps/web/spa/marketplace/`.
- **Onboarding pickers** — `connect-repos`, `connect-search-console`,
  `connect-helpdesk`, `connect-accounts`, tested in
  `packages/official-agents-seed/connect-onboarding-apps.test.ts`.
- **Try one live** — `bun run try <slug>` (`scripts/try.ts`) pushes an authored
  agent into a durable staging workspace and prints its URL. It exists partly as
  a standing check that the public API is clean: if it needs a workaround, the
  API is wrong.
- **Live gate** — the `marketplace` journey in `packages/test-harness`
  (`bun run e2e:staging -- --journey marketplace`) proves catalog read, install
  by listing id, hub sync idempotence and cleanup.

## Dead ends and divergences

**Automation Builder was cut** under the second admission rule. Scheduling work
and wiring webhooks is what Duet *is*; wrapping that in an agent restates the
product back at the user. The tell for any "builder"/"integrator" candidate: its
delegation list would name only platform skills.

**Three seats were written too narrow and had to be widened.** Research
Assistant refused questions about a single company; Data Analyst refused to build
a dataset from documents; Operations Analyst read invoices and then declined to
say what they showed. One cause each time: knowing the whole roster while
authoring, and writing the partition between agents into the prompts as if it
were a limit of the seat. It is not — the colleague imagined picking up the rest
may never be installed.

**The manifest's `description` field was deleted**, and `app` became `apps[]`.
Catalog metadata comes from the agent's own files, not a parallel list that can
disagree with them.

**Not every input needs a connection.** An early pass demanded integrations
uniformly. The test that survived is whether the input has a *file form a person
would actually hand over*: a CSV, a resume, a handbook — take the file and point
at the agent's folder. A support queue or this month's ad results has no file
form, and there the connection is the input, which means an `onboarding` block
and a locked agent until it completes.

**A once-ever check is not a cache.** `connect-repos` first probed the code host
only on the very first read, which fixed the tested case (already authorized)
and broke its neighbor (authorize *after* the failed probe, and the page never
corrects itself). The sibling pages' ten-second window bounds the subprocess
cost *and* converges without user action.

**A green tick beside a failure sentence is not a status.** Connected-but-
unreadable is its own state.

## Choices

`choices.md` beside this file is the decision ledger for the whole build,
including two audit entries worth their own mention: one finding that was
withdrawn because the audit misread the code, and one defect the audit caught in
its own author's work.

## Open

- **Fixed during close:** `packages/skills-registry/skills/go-to-market/sub-skills/ai-search-visibility.md`
  quoted a vendor list price ("$0.004/request") in two places. Duet bills a flat
  rate per successful call for dataforseo, crustdata, fullenrich, elevenlabs and
  socialapi (firecrawl bills by credits/endpoint/duration), so the vendor's
  number was never what a user paid. Both now say the same thing: one billed
  call per request, bound the call count. Never quote a price in a skill or an
  agent — this one was a platform skill in the registry, not agent content,
  which is why reading only `content/` would not have found it.
- The onboarding pages have no automated visual gate — they are VM apps, not
  product UI, so they are in none of the four visual-coverage ledgers. Every
  defect fixed in them was found by rendering and looking.
- Google Search Console is reachable through `composio-credentials` but no skill
  documents its tool slugs. The SEO agent does not degrade without it — it is
  hard-locked behind an `onboarding` block, because a verdict issued blind to a
  site's own impressions is a guess wearing a process.
