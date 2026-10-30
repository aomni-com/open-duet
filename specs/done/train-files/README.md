# Train-to-files — shipped record

**Status: shipped to staging 2026-07-23.** Built in one day from the
[explore-unknowns map](MAP.md) via a 13-slice two-repo ladder, implemented
with Codex and integrator-reviewed. All local gates green; the live staging
e2e was **deliberately deferred by Example User** (parallel staging work in flight
at close time) — the extended journeys are coded and locally tested
(`packages/test-harness/src/staging-e2e-synthetic`, the browser acceptance
train leg), so the first `bun run e2e:staging` after the parallel work
settles exercises them. The decision ledgers are [MAP.md](MAP.md) (pre-spec
walk) and [choices.md](choices.md) (consolidated build choices, ranked
least-confident first — the user's review surface).

## What shipped

In the product, trained memory is markdown files in the drive, not
database rows (the duet-agent CLI keeps `--db` as an explicit standalone
mode; nothing in Duet invokes it). Training
an agent produces `<agentRoot>/.agents/memories/<slug>.md` — synced,
shareable, hand-editable content — and every agent's sessions load their
own memories plus every ancestor's, pinned at the head of the observation
block under an independent 15k-token budget. The root agent's memories simply are the layer every agent
inherits, exactly as skills inherit. The Train control center selects either
the root or an agent beneath `/w/:ws/train`, with owned records
editable and inherited ones read-only; training jobs run
concurrently with no workspace lock. There is no special global
trained-memory namespace — "global" training is just training the root.

The problem it solved: training was workspace-singular (one URL, one root
`memory.db`), sub-agents were untrainable, trained rows were only
*probabilistically* recalled (ranked into a budget), and the PGlite lock
made the records rail a known 502/503 incident class.

## The reason it works this way

- **Files are the drive's native substance.** Trained memory as content
  inherits sync, sharing, replication, archive, and attribution for free —
  and a shared or cloned agent travels with its training. This deliberately
  flips one agents-feature invariant: *curated* memory leaves the machine
  with the folder; *observational* memory (per-agent `memory.db`, outside
  the drive) still never does. The two-tier split — "what you taught it" is
  a file, "what it noticed" is private — is the product story.
- **Inheritance is the skills walk, not a sync protocol.** The earlier
  design (global training as a slug fanned out into every agent's DB) died
  the moment memory became files: an ancestor's file is simply visible to
  descendants via the same `walkAncestors` discovery skills use
  (duet-agent `src/memory/store/discovery.ts`, third consumer of
  `src/lib/walk-ancestors.ts`). Upward-only falls out of the walk;
  read-only inheritance falls out of file ownership. No copies, no drift.
- **One codec owner across two repos.** `@duetso/agent/memory-store` is a
  published zero-dep subpath (enforced by a build-inspection test) and is
  the only code that parses or serializes a memory file anywhere. The
  rejected alternative — duplicating the parser in `@repo/contract` with
  fixture-drift alarms — was two owners for one byte format. The contract
  keeps only zod wire schemas; the web never sees file bytes.
- **Determinism is the training promise.** Store memories bypass recall
  ranking entirely: pinned first, own 15k budget
  (`PINNED_STORE_TOKEN_BUDGET`, duet-agent `src/memory/store/pack.ts`),
  oldest dropped first with a stderr warning, never fatal, loadable with
  `memoryDbPath: false`. DB observations keep their separate 8k ranked
  budget untouched.
- **The gateway is anchorId-native; the API is slug-native.** Agent slugs
  never reach the gateway: the API resolves `agentSlug → agent doc` once
  (Convex owns that mapping) and proxies to `/v1/train/agents/{anchorId}`
  mounts; the gateway resolves anchors through the same
  `agents/agent-context.ts` machinery sessions use. This mirrors the
  agents feature's attribution/runtime split and is why replica
  (share-mount) anchors resolve by projected `agentId`, never
  `anchor.kind`.
- **Concurrency by deletion, not by scheduler.** The one-job-at-a-time 409
  existed to protect a PGlite import lock; with file writes there is
  nothing to protect. The v2 ledger (`train/job-ledger.ts`, new filename,
  old singleton ledgers abandoned unread) holds N jobs; upload inboxes and
  leases are per-scope (`state/train/uploads/{root|anchorId}`).
- **Synthesis is contained twice.** The sub-agent runs with the job-local
  corpus as cwd *and* an explicit `memoryStores: false` (tests in both
  repos) — self-non-contamination is an invariant, not path luck. The CLI
  writes to a job-local store; the gateway installs the file at finalize,
  re-resolving the anchor so a moved agent gets the file in its new root
  and a deleted one fails closed.

## Invariants — what must stay true

- `@duetso/agent/memory-store` is the only memory-file codec, both repos —
  a review invariant held by convention and search, not by a gate (the
  build-inspection test enforces only the subpath's zero-dep purity).
- Memory-file frontmatter never carries `sourceFolder` (an absolute VM
  path in shareable content) and `id`/`archiveId` must be safe path
  segments — the parser and `removeArchive` both enforce it; a synced file
  must never be able to steer a recursive delete outside `~/.duet/train/`.
- The records rail spawns nothing; synthesis is the train rail's only
  subprocess. No DB fallback, no dual write, no `train_job_running`, no
  `memory_lock_timeout` outside the observational `/v1/memory` rail.
- Store memories never enter DB usage-bump, reflection, or recall; the 8k
  observation budget and its ranking are untouched. Pinned tokens report
  under `globalMemory` (the strict 4-field usage protocol does not widen).
- Root response shapes are unchanged — pinned by the response-parity test
  in `packages/gateway/src/train/memory-store.test.ts`. The web control center
  owns both root and agent Train scopes beneath `computer/train`; REST retains
  its root and per-agent resource hierarchy.
- Train job reports carry the VM's `anchorId`. Convex resolves agent
  identity when reconcile births a projection (VM-first race); a report
  naming an unresolvable agent is skipped, never mis-scoped to root; and
  `createJob` tolerates a matching pre-existing row only when scope AND
  creator match.
- Terminal job transitions persist before corpus cleanup, and cleanup is
  best-effort: an rm failure may leak disk, never a stuck non-terminal
  job. Failure cleans the snapshot exactly as success does — a retained
  snapshot with no retry endpoint is unreachable disk growth.
- The inherited list names only stores some Train page can serve (ancestor
  agent root stores + drive root); intermediate hand-made stores inject at
  runtime but are not listed. Public responses carry `ownerAgentSlug`,
  never a gateway anchorId — the read-only 409 included, and unmappable
  owners fail closed as `gateway_failed`.
- Replica agents' Train surface is read-only end to end (UI offers no
  mutations; API 403s them).
- `.agents/**` sync/share/attribution rules are untouched: memories travel
  because they are ordinary drive content.

## Pointers into the code

- Upstream (duet-agent, shipped as `@duetso/agent@0.3.0`; the deployed
  pins have since moved to 0.3.1, a superset released by the concurrent
  connected-providers session): kernel
  `src/memory/store/{file,store,discovery,sources,pack}.ts`; CLI grammar
  `src/cli/memory-sources.ts`; pinned layer wiring
  `turn-runner.ts#refreshPinnedStoreContextPack`,
  `observational-prompts.ts` (`<stored_observations>`); evals
  `evals/train-store.eval.ts`, `evals/store-memory-injection.eval.ts` (the
  real-model inheritance proof).
- Gateway: `train/memory-store.ts` (codec adapter), `train/agent-scope.ts`
  (`resolveTrainScope`), `train/job-ledger.ts`, `train-runner.ts`,
  `auth/upload-{token,scope}.ts`.
- API: `apps/api/src/routes/train.ts` (`resolveTrainTarget`,
  `attributeInheritedOwners`, `translateInheritedConflict`).
- Convex: `domains/train/model.ts` (`reconcileFromVmImpl`,
  `agentByAnchorId`, deep links).
- Web: `spa/api/train-scope.ts` (`TrainScope`),
  `spa/routes/train/train-surface.tsx` (the shared library and training surface),
  `spa/routes/train/train-record-detail.tsx` (dedicated reading and editing),
  `spa/routes/train.tsx` (root and agent route ownership), and
  `spa/routes/agent-train.tsx` (legacy redirects only).
- Visual record: the Train and agent-Train playground scenes and their
  desktop/mobile baselines under
  `apps/web/tests/visual/__screenshots__/` are the accepted look,
  critique-verified; the owned-vs-inherited hierarchy was the judged
  variable.

## Dead ends and divergences

- **Global-memory-as-shared-slug** (fan-out + `train import` primitive +
  drift semantics) — dissolved entirely by files + path inheritance; the
  edit-semantics fork it required never needed answering.
- **`--dir` flag name** — rejected for working-directory ambiguity;
  `--store` shipped. A future single `--store <path>` with inferred type
  remains open as a superseding API.
- **Bounding the discovery walk at driveDir** — rejected; skills accept
  the identical walk-to-root exposure and consistency won.
- **A `pinnedMemory` usage-protocol field** — rejected to keep the strict
  session protocol closed; folded into `globalMemory`.
- **"Retain failed-job corpus for retry"** — shipped briefly, then deleted
  by the whole-spec review: no retry endpoint exists, so retention was
  unreachable disk growth.
- **Per-level inherited listing** — shipped briefly (every ancestor
  directory's store, attributed to the nearest enclosing agent), then
  narrowed: it produced owner links whose Train pages 404'd.
- **Slice 03's manual npm steps** — superseded mid-run by duet-agent's
  release skill (tag-triggered GitHub Actions publish). v0.3.0 shipped
  that way; a concurrent session released v0.3.1 (a superset) minutes
  later and its pin bump has since merged — the deployed pin is 0.3.1.
- **Mid-build additions by the user:** the two real-model evals as a
  pre-release gate, and the `/review`-then-release sequence for the
  duet-agent half (which caught the archiveId-traversal delete escape and
  the relative-`memoryStores` cwd bug before publish).
- The slice files were collapsed at close; the per-slice verification
  history lives in git (`feat(train)`/`feat(memory)`/`feat(gateway)`
  commits, 2026-07-23) and the build-time choices in
  [choices.md](choices.md).

## Open at close

- The live staging e2e run (deferred by Example User; journeys coded and locally
  green).
- Escalations recorded in choices.md and the agents-ui backlog: roster
  cards have no active-state (pre-existing), replica Train banner polish,
  and the strict byte-canonical parse of hand-edited memory files (the
  ledger's least-confident entry).
