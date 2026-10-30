# Hub Content Sync — Quadrant Map

Walked 2026-08-05 with Example User.

> **SHIPPED — THIS IS PROVENANCE, NOT INSTRUCTIONS.** The feature was built and
> closed 2026-08-05; [`README.md`](README.md) beside this file is the rationale
> record and is authoritative for what shipped and what must stay true. This map
> stays authoritative only for *what was decided during the walk and why*.
>
> Two consequences for a reader: **code pointers here describe the PRE-feature
> state** — `writeOfficialSeedFiles`, the once-only `beginSeed`/`completeSeed`,
> and `officialHubSeedRuns` are all gone, so follow the README's pointer table
> instead — and **landmine ⑩'s port claim is wrong**, disproved during the
> build (see the README's divergences). A fresh agent reads the README, not
> this file.

Feature = turn the once-only golden-workspace seed into a **repeatable sync**,
so agents authored in `packages/official-agents-seed/content/` are continuously
pushed into the official hub workspace, while agents created directly in the
hub are never touched.

The real goal is an **incubation → promotion pipeline**, not a replacement of
the golden workspace: create an agent fast inside the product, and when it has
earned "official", move it into the repo. Promotion needs **no mechanism** —
the slug never leaves the hub, so adding the folder to `content/` is the whole
operation. Subscribers see either a normal content update or nothing at all.

---

## Quadrant 1 — Known knowns (settled ground)

**The content and the registrations already live in the codebase.**

- `packages/official-agents-seed/content/agents/**` — three agents authored
  verbatim: `AGENTS.md`, `agent.json`, `CHANGELOG.md`,
  `.agents/skills/*/SKILL.md`, and each agent's `apps/*/server.ts`.
- `src/content.generated.ts` — the same tree base64-encoded, with a drift test
  (`seed.test.ts`). It exists because serverless packaging silently prunes
  dot-directories from runtime asset trees; staging once shipped without
  `.agents/**` (`src/index.ts:31-37`). **The runtime loader must never be
  "simplified" back to a disk walk.**
- `manifest.ts` — the typed registration contract: each agent's slug, name,
  description, path, and its app's `command`, `installCommand`, `apiScopes`.

**The Convex half of a repeatable sync is already built and already
content-aware.**

- `reconcileRegistrations` (`domains/internalAdmin/officialHub.ts:275`) is
  idempotent and checks agents and apps **independently**.
- `appRegistrationDiffers` (`:337-374`) compares `slug`, `command`,
  `apiScopes`, `installCommand`, `name`, `icon`, `port` — so editing an app
  declaration in `manifest.ts` already propagates on a re-run.

**Only the file write is once-only, and it is blind.**

- `writeOfficialSeedFiles` (`apps/api/src/gateway/client.ts:572-612`) loops the
  whole tree and `PUT`s each file at `/v1/files/<path>` unconditionally: never
  reads, never diffs, never deletes. (The converge itself reaps as of 2026-08-11 — see specs/done/default-agents/. As of 2026-08-16 the sync also deletes absent AGENTS — see the note on decision #6.)
- `beginSeed` returns `state: 'existing'` the moment a completed run exists
  (`officialHub.ts:83`, `:161-164`). **That early return is the line that makes
  the seed once-only, and the line the build must change.**

**The rail downstream is untouched by this feature.** Official agents are one
verified listing on the shipped marketplace rail
(`specs/done/agent-marketplace/README.md`): subscriber gateways poll
`<edge>/<ws>/<pub>/<agent>?zip` with `If-None-Match`
(`packages/gateway/src/marketplace/puller.ts:315`), and the materializer does a
three-way repair against the cached upstream snapshot.

**The publish serving floor protects the sync from itself.**
`PUBLISH_FLOOR_SEGMENTS` excludes `.git`, `node_modules`, `.duet-anchor`, and
any `.env*` segment (`packages/contract/src/publishes/index.ts:57-73`), so VM
-installed dependencies inside a synced agent folder are never served to
subscribers and never count against the zip bounds.

---

## Quadrant 2 — Known unknowns (decision ledger)

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Replace the golden workspace with a code-served origin? | **No.** No second listing origin, no `origin` discriminant, no edge branch, no generated zips, no contract change, no schema change, no cutover. The codebase syncs *into* the workspace instead | Example User |
| 2 | What is the source of truth for a synced agent? | **The repo.** Any agent named by `manifest.ts` is code-authored; the hub copy is a replica | Example User |
| 3 | What about agents created only in the hub? | **Never touched.** Scope is defined by the manifest, and enforced in code rather than by convention. This is the incubation guarantee | Example User |
| 4 | How is promotion performed? | **By adding the folder to `content/` + `manifest.ts`.** No promotion mutation, no listing change, no ETag switch, no re-consent. The `listingId`, `installs`, subscriptions and catalog card are all untouched because the listing never moved | Territory |
| 5 | Diff before writing, or blind write? | **The API ships the whole tree blind; the gateway writes only the files whose bytes differ.** The API does no comparison and holds no cleverness. The gateway compares locally — one request, not N round-trips — because writing byte-identical files rotates the mtime-derived publish ETag and badges every subscriber (landmine ②) | Example User (blind API) + revised for #9 |
| 6 | Delete files the repo dropped? | **No deletion, ever.** Removing a file from `content/` leaves the hub copy in place. Removing a whole agent from the manifest is therefore **demotion, not deletion**: the hub keeps serving it, now unmanaged | Example User (follows from #5) |

> **Overturned 2026-08-16 (Example User).** Demotion made every retirement a hand-run
> data operation per environment. The sync now deletes what the manifest
> stopped declaring — agent row and subtree, folder, and the listing steps out
> of the catalog (`retireAbsentAgents` in
> `packages/backend/convex/domains/internalAdmin/officialHub.ts`). Operator
> takedowns still outrank the sync, and restoration is the same press.
| 7 | A human edits a code-owned agent inside the hub | **Clobbered silently.** No conflict copy, no refusal, no trace. Safe only because the hub is a team-owned space and the editors are the repo's authors | Example User |
| 8 | What triggers the sync? | **A human presses the re-runnable internal-admin endpoint. Automation is deferred to its own later slice.** No cron, no new scheduler, no build-rail call | Example User — *revised after drafting; see landmine ⑧* |
| 9 | Should the sync ever skip? | **Never. Pressing the button always converges the hub to the code.** No whole-sync hash gate, no `syncedContentSha`, no SHA-aware state machine. A button that sometimes silently does nothing is a bug, not an optimization. The only comparison anywhere is per-file inside the gateway (decision #5), which is invisible to the operator and exists solely to protect subscribers from ETag churn | Example User — *overturns the assistant's earlier hash-gate proposal* |
| 14 | Does a sync revive an operator takedown? | **No — takedown is sticky.** `registerListingImpl` patches a listing back to `state: 'listed'`, so a re-runnable sync would silently undo an internal-admin takedown of an official agent. The sync skips listings in `state: 'removed'`; takedown stays the one owner of removal. Re-listing is a deliberate admin action, never a side effect of deploying | Assistant (Draft C finding) — *the emergency lever must outrank the routine one* |
| 15 | Dead code found along the way | **Deleted on sight** — dead arguments, schema fields, functions, tests, and the comments defending them. Leave the codebase better than found | Example User |
| 10 | Schema changes | **Additive optional fields only**, per the standing house rule | Territory |
| 11 | Can the hub be paused or archived by billing? | **No — add `servicingExemptAt` on workspaces**, set through internal-admin with an audit row, and have `reconcileServicingStatus` skip workspaces carrying it. Generalizes to any Duet-owned workspace rather than hardcoding the hub slug. Exemption never overrides `banned` | Example User |
| 12 | Delete the dead `idleRetirementExemptAt` column? | **Yes — delete it outright**, along with the stale schema comment that justifies keeping it. No probe, no kill gate, no migration | Example User |
| 13 | Does anything in this plan owe a debt to existing data? | **No. Nothing has launched; prod carries no data and staging is wipeable on demand.** No historical rows, no legacy fields, no migrations, no compatibility reasoning anywhere in the ladder. If a schema change would strand records, wipe them | Example User |

### Rejected alternatives (do not re-walk)

- **Delete the golden workspace; serve official content from the deployed
  codebase** (`origin: 'builtin'` on `agentListings`, `/_builtin/<agent>?zip`
  on the edge, per-agent zips generated at build time). Fully designed during
  the walk, ~5 slices. Rejected because syncing into the workspace achieves
  the same authoring goal with no new architecture and keeps one rail. Its one
  real prize — official agents that cannot go dark with the hub VM — is
  knowingly forgone (see landmine ④).
- **Serving the golden workspace's URL from code while keeping its Convex rows**
  ("option B"). Rejected: a URL naming a workspace, answered by code, backed by
  rows describing files that exist nowhere.
- **A second origin kind plus a promotion mutation carrying acknowledgement
  forward.** Made unnecessary by decision #4 — there is nothing to promote.
- **`buildOfficialSeedBundle()` as the served archive.** It writes a ustar tar
  (`packages/seed-drive/src/deterministic-bundle.ts:29`) for the VM restore
  path; the marketplace puller parses zip via `fflate.unzipSync`
  (`puller.ts:5,580`). Different formats — do not wire them together.

---

## Quadrant 3 — Unknown knowns (extracted)

- **Minimum moving parts is the decisive criterion, not a tiebreaker.** Across
  five separate decisions — no backward compat, clobber silently, post-deploy
  over cron, sync over second origin, blind over diffing — the option that
  added no new architecture won every time. Any future proposal here must
  justify itself against "just re-run the seed."
- **The hub is a team space, not a product surface.** Clobber-silently (#7) is
  safe only while the people editing the hub are the people who write the
  repo. **If that ever stops being true, #7 is the first decision to revisit.**
- **The stated ask was never the real goal.** The walk opened on "distribute
  agents from the codebase" and landed on an incubation→promotion pipeline.
  The spec should open with the pipeline, not with the distribution mechanism.
- **Same slug across promotion is a hard requirement**, and this design gets it
  for free. Any variant that breaks slug continuity is disqualified.
- **Customers sit downstream of an internal tool.** "Internal use only"
  describes who edits the hub, not who feels the consequences — every hub write
  reaches real subscribers' drives. That gap is what decision #9 exists to
  close.

---

## Quadrant 4 — Unknown unknowns (landmine cards)

**① Blind *overwrite* is safe; blind *mirror* would destroy the VM's
dependencies.** *(resolved by decision #6)*
Each seed agent's app installs its deps on the VM via
`installCommand: 'bun install'`, so `node_modules` lives **inside** a synced
folder. A sync that removed anything not present in the repo would delete them
on every run. Overwrite-only never sees them, and the publish floor keeps them
off the wire anyway (`contract/src/publishes/index.ts:73`). **Any future
"clean up stale files" feature must exclude the publish floor.**

**② The publish ETag is stat-derived, so a blind write badges every
subscriber.** *(mitigated by decision #9)*
The zip ETag is computed from path/size/mtimeNs, not content bytes. Rewriting a
byte-identical file rotates it; subscribers then re-download in full, and
`marketplaceSubscriptionHasUpdate` — `appliedEtag !== acknowledgedEtag`
(`apps/web/spa/marketplace/status-projector.ts:26-33`) — flips their agent to
`update-ready`. Without the hash gate, every API deploy shows every customer a
"What's new" on three agents that did not change, until the badge means
nothing. **This defect already exists in a milder form:** re-saving a file in
the hub with identical content rotates the ETag today.

**③ Demotion is silent and irreversible-looking.** *(accepted)*
Because nothing is ever deleted (#6), dropping an agent from `manifest.ts`
does not remove it — it stops being managed and keeps serving whatever bytes
were last written. That is the desired incubation semantics, but it means
"delete an official agent" is a **separate operation this feature does not
provide**, and a half-removed agent leaves no trace explaining itself.

**④ The hub remains a single point of failure for official agents.** *(known,
knowingly kept)*
Landmine ⑥ from the marketplace map survives untouched: `resolveForEdge` serves
a paused page the moment `servicingStatus === 'paused'`, and archives 7 days
later. Idle retirement is exempted (`idleRetirementExemptAt`); **billing is
not.** The rejected code-served design was the only one that removed this.

**⑤ The file write is N sequential round-trips inside one serverless
request.** *(ceiling, not yet a problem)*
`writeOfficialSeedFiles` issues one `PUT` per file from a Vercel function
(`client.ts:583-602`). Three agents is fine; the roster growing is what turns
this into a timeout. The hash gate (#9) keeps it off the deploy path in the
common case.

**⑥ Dot-directories are a solved trap that can be un-solved.** *(guard)*
`.agents/skills/**` reaches the runtime only because `content.generated.ts`
bundles it as source; a disk walk loses it in the deployed function
(`src/index.ts:31-37`). The drift test is the guard. **Do not refactor the
runtime loader to read `content/` directly.**

**⑦ The seed's early return is load-bearing in both directions.** *(build
note)*
`beginSeed` returning `state: 'existing'` (`officialHub.ts:83`) is what makes
the current seed safe to call repeatedly *and* what makes it never sync again.
The build must keep the idempotent workspace **adoption** (`:105-126`, added
after a live staging run where a wiped ledger stranded the seed forever) while
removing the "already completed, do nothing" short-circuit.

**⑧ There is no post-deploy hook to hang the sync on.** *(found during drafting;
closed decision #8)*
`apps/api/vercel.json` defines a **`buildCommand`**, and
`scripts/vercel-deploy-rail.mjs` runs convex deploy → seed publish → api build —
all **before** promotion. Calling the sync from that rail would target the
*previous* deployment. Worse, `README.md:154-159` states that **every branch/PR
preview shares the persistent staging Convex deployment**, so any
deploy-triggered sync that does not filter by branch would have PR previews
writing the shared staging hub. Automation therefore needs a genuinely new
runner (deployment-success event, environment filtering, short-lived auth,
dedup) — which is why v1 is a manual press.

**⑨ A stale comment will try to talk you out of deleting a dead column.**
*(resolved by decision #12 — do not re-litigate)*
`idleRetirementExemptAt` is read and written by nobody, and idle retirement no
longer exists in the codebase, but `schema.ts:315-317` argues for keeping the
optional validator: *"Historical rows may still carry this removed policy's
value. Keeping the optional validator avoids a data migration."* **That
reasoning does not apply here and never will.** Nothing has launched, prod
carries no data, and staging is wipeable — see decision #13. Delete the field
and the comment together. The same applies to any future "but existing rows"
argument encountered in this codebase: check whether real data exists before
believing it. **Standing rule: a dead column is deleted the moment it is
found** — no probe, no ticket, no "leave it for now"; the field and any comment
defending it go in the pass that found them.

**⑩ Three defects sit directly on this feature's path.** *(found during
drafting, all verified)*
- ~~`appRegistrationDiffers` ignores port **removal**~~ — **THIS CLAIM IS
  WRONG; the build disproved it.** An absent manifest port means "assign one",
  not "have none", and every seeded agent omits it, so comparing it
  unconditionally reports a difference forever and churns a running app's
  address on every sync. The existing guard is correct and still stands. See
  the README's divergences and `choices.md` #1.
- `hubBaseUrl` is a dead argument — supplied at `internal-admin.ts:93`,
  `new URL()`'d at `officialHub.ts:158`, never used or stored.
- `seed.test.ts:24` asserts authored folders **exactly equal** the manifest
  (`expect(authoredAgents).toEqual(...)`), which forbids the demotion decision
  #6 defines. The assertion must become "every manifest agent has a valid
  authored root"; extra roots are allowed and simply excluded from the payload.

**⑫ A re-runnable sync silently revives operator takedowns.** *(closed by
decision #14 — this is why that decision exists)*
`completeSeed`'s per-agent loop calls `registerListingImpl`, which patches an
existing listing to `state: 'listed'`, `availability: 'available'`
(`domains/marketplace/listings.ts:172-187`). `takedownListingImpl` sets
`state: 'removed'` and `installs: 0` (`listings.ts:723`). Making the seed
re-runnable therefore un-does an official-agent takedown on the next press,
silently and visibly to customers. **This exact harm is why a predecessor
feature was deleted**: `specs/done/agent-onboarding/choices.md:326-329` cites
"resurrect agents they had deliberately deleted." The guard belongs in
`completeSeed`'s loop, **not** in `registerListingImpl` — the SPA re-register
path arguably should revive, and bending shared marketplace behavior to serve
the sync would be the parallel-abstraction move.

**⑬ A fresh hub is born paused under an unpaid owner.** *(shapes decision #11)*
`createWorkspaceRow` stamps `servicingStatusFor(workspace, billingUser, now)` at
birth, and `bypassWorkspaceLimit` only skips the creation-capacity assertion — it
does not affect the servicing stamp. So
exempting only `reconcileServicingStatus` would leave a
newly-provisioned hub born `paused`. The exemption must live in **one
workspace-aware predicate** that both birth and reconcile route through;
`desiredServicingStatus` stays user-only and must not learn about workspaces.

**⑭ One agent's change badges only that agent's subscribers.** *(corrects an
earlier assistant claim)*
The zip ETag is computed by `zipTreeEtag` over the entries of
`collectPublishSubtree`, rooted at the **requested subpath**
(`packages/gateway/src/routes/files.ts:516-528`,
`routes/publish-subtree.ts:57-64`). Each official agent is polled at its own
subpath, so rewriting one agent cannot rotate another's ETag. Earlier in the
walk I said a sync would light up all three agents at once; that was wrong.
Directories are also filtered out before the ETag is computed
(`files.ts:522`).

**⑪ The file write is not atomic across the bundle.** *(sharp edge)*
Each gateway `PUT` replaces one file atomically, but a multi-file sync has no
transaction, so a subscriber polling mid-sync can observe a mixed-version tree.
A failed partial sync can also rotate the public ETag without completing. The
`syncedContentSha` must therefore be committed **last**, after every write
succeeds, so a retry stays eligible.

---

## Dead code this feature deletes (decision #15 — standing mandate)

Found during the walk and the drafting pass; all verified. Delete the thing and
any comment defending it, in the pass that touches it.

| What | Where | Why it's dead |
|---|---|---|
| `idleRetirementExemptAt` | `schema.ts:317` + its comment `:315-316` | Idle retirement no longer exists; nothing reads or writes it |
| `hubBaseUrl` argument | supplied `internal-admin.ts:93`, validator `officialHub.ts:153`, `new URL()`'d `:158` | Parsed and then never used or stored |
| `completedReport` | `officialHub.ts:258-273` | Loses its only caller when the once-only short-circuits go |
| The once-only short-circuits | `officialHub.ts:67-81`, `:92-97`, `:161-164` | The whole point of the feature is that they go |
| `'existing'` / `'created'` states | `packages/contract/src/internal-admin/index.ts:214-219` | Replaced wholesale; no SPA consumer, so a hard cutover costs nothing |
| The inverse-of-this-feature test | `packages/backend/src/official-hub-seed.test.ts:164` | Asserts "seeding an existing hub changes nothing — the VM owns its agents after bootstrap"; that is exactly what this feature reverses. Replace, never patch |

**Not dead, but broken and on the path — fix it here:**
`appRegistrationDiffers` ignores port *removal* —
`registration.port !== undefined && app.port !== registration.port`
(`officialHub.ts:372`) — so clearing a manifest port never propagates.

---

## Build sketch — SUPERSEDED

> See the [shipped rationale](README.md) for the current design.
