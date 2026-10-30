# @repo/official-agents-seed

The repo's claim about what the official-agent hub should contain. `manifest.ts`
names the agents this package owns and declares their agent and app rows;
`content/agents/` holds their authored files.

The manifest is the **only** list of code-owned agents. Everything downstream —
the API route, the gateway — receives an already-scoped plan from
`buildOfficialSyncPlan()` and never filters again.

Run `bun run inspect` to see exactly what a sync would write, grouped by agent.

## Visual proof belongs beside the authored apps

The scenario registry under `tests/visual/` is the source of truth for each
app's committed visual states. It starts the production app factory with fresh
storage, arranges state through the public HTTP API, and captures both standard
viewports in the repository's pinned Docker runner. This keeps screenshots
repeatable without turning staging pixels or provider accounts into baselines.

Use `bun run agent-apps:check` from the repository root for the whole owner, or
the existing `bun run ui:check <agent-app-id>` grammar while iterating on one
scene. Approval uses the matching `agent-apps:approve` / `ui:approve` command.
Only container approval is authoritative.

Screenshots are deliberately committed and expected to change often with the
default agents. Review the rendered result before approval and commit the
scenario, generated coverage ledger, root visual index, and PNGs together. For
a removed or renamed scene, run full owner approval: the verifier may delete
stale files only under this package's screenshot root. A focused approval
never prunes unrelated baselines.

Whether an agent *should* be official — the refusal that earns it a place, the
role rule, the non-technical voice, and what an agent must tell a user about
its app — is in [AUTHORING.md](AUTHORING.md). This file is the mechanics.

## Promotion: moving an agent from the hub into the repo

An agent created directly in the hub is yours to iterate on freely; nothing
here touches it. When it has earned "official":

1. Add its folder under `content/agents/<slug>/`. Its `AGENTS.md` is doing two
   jobs at once: the first paragraph becomes the listing summary a browser
   reads, and everything after it is the agent's system prompt. Its
   `agent.json` carries 1–3 `tags` from the closed vocabulary in
   `@repo/contract` — every listing needs at least one, or the catalog's filter
   has no chip that reaches it.
2. Add its entry to `manifest.ts` — slug, display name, path, and an app only
   if it needs one. Nothing a browser sees is declared there; see below.

   **Most agents have no app.** One earns its place by doing something the chat
   cannot: holding state, showing a board, taking structured input. An app that
   only restates the agent's own prose is worse than none — it is the first
   thing a new user opens, and three of those shipped here before being
   deleted. When an agent does declare one, it declares an `icon` and ships the
   file it names beside the app, because an app with no artwork is drawn as two
   letters everywhere the product shows one; the seed test refuses that.
   An app declaring `apiScopes` is issued its own `$DUET_APP_API_KEY`, which is
   what lets it call the platform — integrations for an onboarding picker,
   `services` for a provider proxied through Duet. Give it the one capability
   it uses and nothing else; whether a paid call belongs to the app at all is
   [AUTHORING.md](AUTHORING.md)'s question, not this file's.
3. The [staging app journey](../test-harness/src/staging-live-official-agent-apps.ts)
   derives app ownership and authored headings from the manifest and generated
   content. Keep its behavior tests independent of the catalog roster so adding
   an app does not require a second declaration.
4. Run `bun run codegen` — the runtime loads the generated module, not the
   directory, and the drift test fails until you do.
5. Deploy, then press **Sync from repo** in internal admin.

Nothing else happens. Because content syncs *into* the hub, the agent's slug
never moves, so its listing, its subscribers, and their installed copies are
untouched. Subscribers see either a normal content update or nothing at all.

## Catalog metadata is derived, never declared

Title aside, everything the marketplace shows for an official agent — summary,
skills, changelog — is computed from that agent's own authored bytes by
`deriveListingMetadata`, the same function an outside publisher's listing goes
through. This package builds the origin snapshot from its generated content
instead of asking a gateway to inspect a folder we already hold; that is two
producers of one shape, not two derivations.

The rule matters because the alternative was live here until recently: the sync
used to hand-build listing metadata from manifest fields and hardcode `skills:
[]` and `changelog: ''`, so official agents shipped real skills and changelogs
that the catalog silently threw away. If you find yourself adding a field to
`manifest.ts` that a user would read, put it in the agent's files instead.

## Three things that will surprise you

**A sync makes a managed root match the repo — including deletions.** Under a
root `manifest.ts` names, a path the plan no longer claims is reaped, so a
removed or renamed file leaves the hub. It is a diff, not a wipe: identical
bytes are never rewritten, because the publish ETag is stat-derived and a
needless rewrite would push a full re-download to every subscriber.

App registrations follow the same rule — an app the manifest stops declaring is
retired, and one it declares again is revived.

**Dropping an agent from `manifest.ts` is demotion, not deletion.** It stops
being managed and keeps serving whatever bytes were last written. That is the
intended way to hand an agent back to hub-authoring — but it is silent, so
nothing on the hub will tell you it happened.

**A reap can empty a folder without removing it.** The publish floor
(`node_modules`, `.git`, `.duet-anchor`, `.env*`) is never deleted, and `rmdir`
refuses a non-empty directory — so a folder the repo abandoned entirely leaves a
husk behind if anything installed dependencies there. `data-analyst` still holds
`apps/analysis-dashboard/node_modules` for exactly this reason, long after the
app left the repo. It is litter, not a defect: excluded from the publish, absent
from the archive, invisible to anyone installing. Delete it by hand if it
bothers you.

**Renaming anything is a copy, not a move — but the reap now catches it.**
Renaming a bundled skill directory is a delete plus an add, and before the reap
landed the hub served both names — so somebody installing the agent got the old
set alongside the new one, while the listing looked correct because its metadata
derives from the repo's bytes. That is fixed: a sync removes what the plan no
longer claims, so a rename converges. The failure mode is worth remembering
anyway, because it is what a floor-protected husk still does on a smaller
scale.

**Editing a code-owned agent inside the hub is overwritten without warning.**
No conflict copy, no refusal, no trace. If a slug is in `manifest.ts`, the repo
is its source of truth; edit it here.

## Why the runtime never reads `content/`

`loadOfficialSeedFiles()` decodes `src/content.generated.ts` rather than walking
the directory, because serverless packaging prunes dot-directories from runtime
asset trees — a staging seed once shipped with no `.agents/**` at all. The drift
test pins the generated module to the authored tree; `content/` stays the
authoring source and nothing else.

Editorial copy remains provisional until David approves it for production.
