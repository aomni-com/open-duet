# Choices ledger — agent-marketplace

Every decision made without you, re-audited against the **finally shipped code**
rather than the pass that introduced it. Build-order sediment, superseded
entries, and "will confirm in a later slice" verdicts are gone: if it is here, it
is what the code does today.

Ranked least-confident first. Each entry stands alone — no slice numbers, no
prior reading required.

---

## Provisional — yours to confirm or overturn

**The VM-sync wire field `officialAgentPullReports` is now
`marketplacePullReports`, with no compat for the old name.** *Why:* you asked for
the `official-agents` vocabulary deleted with no legacy, and this was the last
live wire name carrying it. *Cost:* the field is optional and zod strips unknown
keys, so a staging VM still running the older gateway does not error — its
marketplace pull reports are simply dropped until it picks up the new gateway,
after which they settle normally. Nothing else on the sync payload is affected.
*Overturn if* you would rather a wire name outlive a rename than accept that
window.

**Consent is asked only for an unverified publisher that ships apps, and only
per install attempt.** A listing with no apps installs with no sheet regardless
of publisher. Correcting a local path collision stays inside the same attempt,
so it does not ask again; cancelling or beginning another install does. *Why:*
apps are the only thing carrying commands and scopes, so a listing without them
has nothing to disclose; and persisting consent means storing a decision about a
publisher whose apps can change afterwards. *Cost:* a repeated install of the
same unverified listing is a repeated sheet. *Overturn if* you want consent
remembered per publisher.

**An installed agent's slug comes from its FOLDER, not the listing's name.**
Install a second `research-assistant` at `agents/research-assistant-acme` and the
agent's slug is `research-assistant-acme`. *Why:* agent slugs are unique per
workspace, so reusing the listing's name made the second install die on an
untyped "Agent slug already exists" — the exact case listing-keyed install
exists to support. The folder is what the user chose and is already proven free.
*Cost:* for a renamed install the slug no longer matches what the publisher calls
it. *Overturn if* you want the slug to always track the listing, which needs
slugs that are not workspace-unique.

**Availability is DERIVED on a 15-minute cron, never reported by subscribers.**
A listing greys when its publisher's workspace is not active, is suspended or
paused, its publish or anchor is gone, or its URL fails its own schema. *Why:* a
subscriber-reported verdict lets one hostile installer grey out a rival. Every
way a publisher actually goes dark is a fact the backend already holds, so
deriving is both cheaper and unabusable. *Cost:* a publisher whose VM is broken
while the workspace still reads healthy stays `available` until an installer's
pull fails. *Overturn if* you want a true origin probe — that needs an API-side
scheduled route, which this repo has no rail for.

**A deployment missing `DUET_EDGE_HOST` leaves availability UNCHANGED rather
than greying everything.** *Why:* that is a deployment fault, not a publisher
fault, and greying the whole catalog would be the loudest possible wrong answer.

**The campaign and onboarding field that lists auto-installed agents is
`starterAgents`, not `marketplace`.** *Why:* everything else became one word,
but "marketplace" says nothing about *which agents a campaign installs at
signup*. *Cost:* two vocabularies in adjacent code. *Overturn if* you would
rather have one word everywhere at the cost of a meaningless field name.

**The consent sheet appears for UNVERIFIED publishers only; verified installs
stay zero-friction.** *Why:* consent is a decision about *who* you trust, and
the verified badge already answers that. *Overturn if* you want every install to
carry the ceremony.

**The catalog is two sections — "From Duet" pinned above "From the community" —
each rendering only when non-empty.** *Why:* with only official listings the
surface is exactly today's surface, which is the launch state since publishing
is gated off. *Overturn if* you want a dedicated Marketplace tab with search and
sort.

**`?zip` is baked into the derived source URL, not appended by whoever fetches
it.** *Why:* it makes "this URL can only request an archive" something the
receiving gateway can *check* rather than a convention it must remember. *Cost:*
a future non-zip fetch from a source URL needs the schema widened.

**A malformed listing subpath is refused, never normalized.** `'a/'`, `'./x'`,
`'a//b'`, `'..'` all fail. *Why:* a subpath needing cleanup means a malformed
row, and silently repairing it hides whatever wrote it.

**Takedown requires the typed phrase `TAKE DOWN LISTING` and lives in its own
Marketplace section of the internal-admin panel, addressed by listing id.**
*Why:* it is irreversible for every installer at once. Addressed by id rather
than a picker because the operator arrives from a report that already names the
listing, and a browsable list invites taking down the wrong one of two
same-named listings.

**`observedAt` on an error pull report is OPTIONAL.** A report without one is
applied as before. *Why:* a gateway predating the field still reports usefully,
and the VM fleet updates on its own schedule. *Cost:* the stale-error guard only
protects reports from gateways new enough to stamp them.

**A dead publisher origin backs off for 6 hours, and a PAUSED publisher is not
covered by that path.** A paused workspace serves its paused page as a
non-archive 200, so it is caught by content-type, not status. *Overturn if* you
want paused publishers on the long backoff too — the signal has to come from
content-type.

**`officialHubSeedRuns` was kept when its sibling `officialHub` was deleted.**
*Why:* the run ledger is the seed's own begin/complete orchestration and nothing
else claims that job, whereas `officialHub` genuinely had a second owner saying
the same thing. *Overturn if* you want seed idempotency rebuilt on listings
alone.

**Internal-admin hub access resolves the workspace by the seed manifest's slug**
rather than by any row. *Why:* the workspace's identity is the durable fact; it
exists whether or not a seed run was recorded. *Cost:* the manifest slug is now
load-bearing for operator access.

---

## Settled by evidence

**Three defects outside this feature, found by the close-out gates and fixed
rather than left red.** They are recorded here because I decided to fix them
without asking, not because the marketplace caused them.
- A generation whose provider omits `native_tokens_cached` now reads it as zero
  cache reads instead of discarding all token telemetry. Before, one missing
  optional field erased `usage`, and a **tiered** generation with no `usage`
  fails settlement as `missing token telemetry` — so every such call parked
  unbillable and retried forever. A test pinned the old behaviour with no stated
  reason; it is replaced by one that states the money consequence.
- Three model-gateway money-path tests asserted pre-tier shapes: the flat
  `{total_cost, inputTokens, outputTokens}` metadata the reconciler stopped
  storing, `actualCostMicroUsd` on a generation row that never had it (it is a
  reservation-transaction field), and the **upstream** cost where the wallet,
  the monthly rollup and `billedCostMicroUsd` all record the **tier** price.
  The last one is the substantive one: asserting upstream cost for tiered
  traffic only passes if tiers bill at cost, which is the thing tiers exist to
  change. The tier price is now derived from `priceTierUsageMicroUsd`, never
  hardcoded.
- The agent roster's entry link took its accessible name from its contents, so
  it announced as `"brief-writer Active"` and changed whenever the agent's
  status changed. It now carries an explicit `aria-label` of the agent name.

**`sweepListingAvailability` became the single writer of BOTH derived listing
columns — `availability` and `appDeclarationRevision`.** *Scenario:* a publisher
edits one of their app's commands from `bun run start` to `bun run serve` and
changes no file. The archive the subscriber pulls is byte-identical, so the
stat-derived `appliedEtag` — the "have the files changed?" clock — sees nothing.
`appDeclarationRevision` is the second clock that exists precisely to catch
this: a fingerprint of every contained app's command, install command, path and
scopes. Today the cron sweep that already walks every listed listing every 15
minutes recomputes that fingerprint and writes it when it moves, so the change
reaches installers on the next pass. Before this, the fingerprint had exactly
one writer — a mutation named `refreshListingAppDeclarations` that **nothing
called**. Its unit test called it directly and went green, so the function was
proven while the stored column never moved in production and the command change
reached nobody, ever. The unbuilt alternative: hook the recompute into the apps
domain so it fires on every app create/update/disable — exact and instant, but
it is a fan-out across many call sites, and missing one is how this broke in the
first place. *Reach:* propagation of declaration-only changes is now bounded by
the sweep's 15-minute cadence, and any future derived listing column should join
this sweep rather than grow its own writer.

**The declaration fingerprint got its OWN budgeted pass, after the close-out
audit caught the first attempt regressing the availability cron.** *Scenario:*
fingerprinting one listing reads its publisher's entire app list. The first fix
folded that into `sweepListingAvailability`, which walks up to 500 listings in
one go — so a pass cost O(listings x publisher apps). A Convex mutation is a
single transaction with a per-transaction document-read ceiling; at 500 listings
averaging 32 apps that is ~16,000 reads and the pass fails **entirely**. Nothing
is stamped, `availabilityCheckedAt` never advances, the least-recently-checked
ordering re-selects the identical rows, and the whole catalog's availability
stalls silently and permanently. The same edit also placed the new call outside
the per-listing try/catch that `listingIsServable` already uses, so one throwing
listing could abort the pass the same way. Today the fingerprint lives in
`sweepListingAppDeclarations`, its own 15-minute cron, which spends a **read
budget** (default 4,000 documents) rather than a listing count — a fixed page
size cannot bound it, because one publisher with 500 apps can blow the ceiling
alone — checks the budget only between listings so a fingerprint is never
computed from a half-read app list, rotates on its own `appDeclarationCheckedAt`
stamp so a budgeted cut cannot starve the tail, and catches per listing so one
bad row cannot strand the rest. `containedAppsForListing` now reports
`documentsRead` because only the walk knows how big the publisher's app list
actually was. *Reach:* any future derived listing column whose cost depends on
another table's size belongs in this budgeted pass, not the availability sweep;
availability stays O(listings) precisely so it can never fail its own
transaction. *Verdict: sound, having been redone from the corrected decision —
a whole-catalog batch pass must cost O(listings) and no single listing may abort
it.* *Confidence: medium-high.*

**Two consumers that matched the old `agents/official/...` URL segment by hand
were repointed at `agents/marketplace/...`.** `loading/loading-route.ts` was
sending marketplace detail to the generic loading frame, and
`drive/agent-roster-rail.tsx` was dropping Agents Home's active state on every
listing page. Both were invisible because the loading-route test asserted the
old path, so it passed against a URL the router had stopped producing.

**Install identifies a LISTING, never a bare agent name.** `listingId` is
required on every subscription, and replay identity is
`(workspace, listing, canonical path, subscribe)`. Two publishers may ship
`research-assistant`; comparing names silently adopted the wrong publisher's
subscription. Bare names survive in exactly one place — onboarding and campaigns
— resolved inside the workspace with the official manifest slug.

**Verification is publisher-scoped (`workspaces.verifiedPublisherAt`), never per
listing.** Consent grants ongoing trust to a publisher, so verification lives
where the trust does. Listings derive `verifiedPublisher`; they never store it.

**The verified badge renders only for verified publishers.** It was
unconditional, which asserted to every user that a stranger's agent had been
reviewed by Duet — the precise claim the consent sheet exists to avoid.

**One constructor builds a source URL (`deriveListingSourceUrl`) and one
allow-list validates a received one (`isEdgeHost`).** The gateway re-parses every
URL it is handed before fetching, so the backend being the sole supplier is not
the only thing between a VM and an arbitrary host.

**The puller fetches with `redirect: 'manual'` and treats any 3xx as a failure.**
The allow-list only ever checked the URL the puller was *handed*; a followed
redirect would fetch whatever host the response named, unchecked.

**The materializer journals on the DRIVE's filesystem
(`<drive>/.duet/marketplace/<id>`), not the gateway's state dir.** It installs by
hardlinking and quarantines by renaming — both same-filesystem operations, and
the drive is a separate volume on every real VM. Every unit test pointed both
dirs at one tmpdir, so a cross-device journal passed the whole suite and had
never once materialized a file on a real VM.

**A changed source keeps the previous manifest when the target directory is
unchanged.** The manifest records what the publisher used to own; dropping it
makes every file on disk look like a local addition, so anything deleted
upstream survives forever. The ETag is deliberately not carried — the new source
is always fetched in full.

**One owner answers "would this origin serve its archive?"
(`publishOriginRefusal`), shared by the edge resolver and the availability
sweep.** They each kept their own list and the marketplace's was shorter, so
paused and suspended publishers read as installable.

**The availability sweep takes least-recently-checked first, never a fixed
prefix.** A stable `.take(N)` rescans the same rows forever, leaving listing N+1
with no verdict — silently.

**Takedown's drain continues itself.** It returned `remaining` to a caller that
had to loop, and no production caller existed, so every subscriber past the
first batch kept marketplace ownership indefinitely.

**Contained apps have one owner (`containedAppsForListing`), and containment is
applied BEFORE any cap.** The consent sheet, the declaration revision, and what
actually gets copied all derive from it. The predecessor read the publisher's
entire workspace and threw before filtering, so a prolific publisher broke
installs of every agent they listed.

**Two clocks: `appliedEtag` for files, `appliedAppRevision` for app
declarations.** The stat-derived ETag cannot see a Convex row edit, so a
publisher changing only a command or a scope would otherwise never reach
installers.

**A listing stores `publishId`, never a copied publish slug.** `updateSlug`
patches the publish row independently, so a cached slug rots the moment a
publisher renames.

**`edgeHost()` fails closed and is called lazily, inside the projection loop.**
An eager call would break `vmSync` fleet-wide on any deployment whose env has
not received the value; lazily, such a deployment is merely unable to serve
listings.

**Re-registration replaces identity, not just metadata** — agent, anchor,
publish, subpath and overrides all patch, so recreating an agent under the same
slug cannot leave the catalog pointing at a dead publish.

**One registration contract (`registerListingFromAgent`).** The raw
`registerListing` mutation accepted caller-supplied ids without checking they
belonged to the workspace.

**A tier never crosses the agent boundary.** Tiers are Duet's concept; duet-agent
implements virtual models and has no field for one. A tier reaches it exactly
once, as the `--model` spawn flag, and the RPC process lives for a single turn —
so spawning IS the per-turn switch. The `tier` we had added to the agent's prompt
command was dead weight that could only have meant mid-turn switching, which is
neither wanted nor supported.

**The rail is called "marketplace" everywhere**, including the VM sync wire, the
gateway pull route, on-disk state, and every DOM hook. Kept as real names, not
vocabulary: `official-agents-hub` (the verified publisher's actual workspace
slug), `packages/official-agents-seed`, and `DUET_OFFICIAL_HUB_OWNER_EMAIL`.

**Pre-marketplace URLs are deleted, not redirected.** We have not launched; a
bare agent name cannot address a listing anyway.
