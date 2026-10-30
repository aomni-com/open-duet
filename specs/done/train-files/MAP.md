# Train-to-files — quadrant map

**Walked 2026-07-22** (explore-unknowns). Status: **superseded by the spec —
see [README.md](README.md) for the build ladder and the decisions closed at
spec time.** This file remains the pre-spec decision record (the why); where
the two disagree, the README wins.
The feature: trained memory becomes inherited markdown files in the drive,
replacing DB rows; every agent gets its own Train surface; sub-agents inherit
the root agent's trainings the same way they inherit skills. The spec that
builds from this map covers **both repos**: `duet-agent` (upstream CLI +
loader) and `duet` (gateway/api/web/convex).

## Known knowns — the territory

- Trained memory today is a `kind='manual'` row in `memory.db` tagged
  `train` + `train:<slug>` (`~/dev/duet-agent/src/train/tags.ts:20`), loaded
  probabilistically — ranked by `manualBias` and greedy-fitted into a budget
  (`~/dev/duet-agent/src/memory/loader.ts:55,80`). Training is never
  guaranteed into context.
- The whole train rail is workspace-singular and hardwired to the **root
  agent's** DB: route `computer/train`
  (`apps/web/spa/routes/product-destinations.ts:54`), REST
  `/v1/ws/{slug}/train/*`, gateway `dbPath: config.memoryDbPath`
  (`packages/gateway/src/runtime/http.ts:606`) = `~/.duet/memory.db`
  (`runtime/env.ts:133`). Sub-agent DBs at `~/.duet/agents/<anchorId>/memory.db`
  (`gateway/src/agents/agent-context.ts:121`) are unreachable by training.
- Multiple runs already accumulate: unique slug per run
  `train-<date>-<jobpart>-<hash>` (`gateway/src/train/job-ledger.ts`),
  records listed newest-first in the UI (`spa/routes/train.tsx:987`).
- Skills inheritance, the model to copy: `walkAncestors(cwd)` → filesystem
  root, scanning `<ancestor>/{.duet,.agents,.claude}/skills` at each level,
  nearer wins on name collision (`~/dev/duet-agent/src/turn-runner/skills.ts:49`,
  `src/lib/walk-ancestors.ts` — the walk deliberately has one owner).
- Sync-ignore contract (`packages/contract/src/sync-ignore/index.ts`):
  `.agents` appears in **no** ignore group → mirrors and travels on shares
  uniformly, root and nested. `.duet` is root-ignored on the mirror and its
  role is "gateway drive-local staging"; attribution drops `.duet/**`
  (`gateway/src/attribution/fanotify-codec.ts:396`).
- Serialization of train jobs (one at a time, 409) existed to protect the
  single PGlite import lock — the cause of the `memory_lock_timeout` incident
  class. With files there is no shared write target.
- Agents-ui shipped: roster rail (one header Train link,
  `spa/drive/agent-roster-rail.tsx:105`), detail canvas
  `/w/:ws/agents/:agentSlug` (`spa/routes/agents/agent-detail-canvas.tsx`).

## Known unknowns — decision ledger (all closed)

| # | Decision | Why | Closed by |
|---|---|---|---|
| 1 | **The CLI grows two memory store modes: `--db <file>` (existing) and `--store <folder>` (new), both repeatable, on every memory command** (`train`, `train list/show/update/delete`, `memory add`; `recall` stays `--db`-only — store memories are always in context, so recall never applies to them). Explicit flags replace auto-discovery; with no flags, the store walk auto-discovers like skills: reads see the union of `<ancestor>/.agents/memories/` from cwd upward plus the default db; writes target the nearest ancestor's memories dir (run train from the agent directory, zero flags). Slug collisions resolve nearest→root, stores before dbs; list entries carry a `store` provenance field. Files kill the lock-race incident class and make training deterministic instead of recall-ranked. | One concept, two backends; `--dir` reads as working-directory; keeps the existing `--db` contract untouched; auto-discovery makes the common case flagless. | Example User + brainstorm |
| 2 | **Location: `<agentRoot>/.agents/memories/<slug>.md`**, beside `.agents/skills/`. Never `.duet` (root-ignored on mirror, staging-dir role, attribution-blind). | `.agents` syncs/shares uniformly; symmetry with skills. | Territory + Example User |
| 3 | **Inheritance = the ancestor walk, upward only.** Loader auto-discovers `.agents/memories/*.md` from cwd → root at spawn (no flags; explicit `--store` is the override for callers with no ambient cwd) (third consumer of `walkAncestors`), nearest wins on filename collision. Root never sees sub-agent memories; nested agents inherit through the chain. No "global memory" concept — root trainings simply are the inherited layer. | Copies skills semantics byte-for-byte; directionality falls out of the walk; no fan-out, no copies, no drift. | Example User |
| 4 | **Inherited entries are read-only at the sub-agent by construction** — they live in the ancestor's directory; the sub-agent's Train screen labels them "inherited" and edits route to the owner. | One file, one owner. | Territory |
| 5 | **One file per run; slug = filename; auto-derived slugs** (existing `train-<date>-<jobpart>-<hash>`), no user naming. | Example User: auto. | Example User |
| 6 | **Concurrent training jobs; delete the VM-wide singleton + 409.** Job ledger holds N in-flight jobs; each writes its own file. Uploads inbox gains an agent dimension (`stateDir/train/uploads/<anchorId|root>`); snapshot-move semantics unchanged. | The serialization guarded a lock that no longer exists; removing it is the simpler architecture. | Example User |
| 7 | **Load semantics: store memories are pinned at the head of the observation block under their own budget — 15k tokens, separate from the observation `tokenBudget`** (default 8000, `loader.ts:99`). Not system prompt, not recall-ranked, never competing with DB observations for room. Past 15k: truncate (newest-first survives), warn on stderr, agent keeps running — never fatal. Reuses the existing context-pack rendering, no new context section. Index+lazy is the later escape hatch, not built now. | Determinism is the product promise; a separate budget means training can't starve observational memory, and overflow degrades instead of blocking. | Example User |
| 8 | **No migration.** Staging-only, no users; old train rows in root `memory.db` are abandoned in place. | Example User. | Example User |
| 9 | **One Train control center owns both scopes.** Root lives at `/w/:ws/train`; selecting an agent uses `/w/:ws/train/agents/:agentSlug`. REST keeps `/v1/ws/{ws}/agents/{agentSlug}/train/*` for agent resources and `/v1/ws/{ws}/train/*` for root resources. | Training controls and memory navigation need one stable product surface, while the resource API remains scope-explicit. | Example User |
| 10 | **Manual "add memory without training" writes a file too** (small `<slug>.md`). The DB `memory.add`/`memory.search` endpoints remain the agent-runtime observational rail, untouched. | Files are the curated substrate now; observational memory stays private per-agent. | Recommendation, decide-and-inform |
| 11 | **Sharing/cloning an agent carries its trained memory** — `.agents/` is folder content, exactly like skills. Deliberate reversal of the "memory never leaves on share" invariant for the *curated* tier only; observational DB memory still never leaves. Live shares keep receiving the origin's future trainings via sync. | It's the feature (pre-trained shareable agents; official-agents hub synergy). | Example User (stage-2) |

## Unknown knowns — extracted taste

- Training is **curated knowledge**, a different sensitivity class from
  session-derived memory: shareable, visible, user-editable. The two-tier
  split (files = what you taught it; DB = what it noticed) is the product
  story.
- "Files are truth" is the standing architecture philosophy (agents spec:
  config is content, read fresh at spawn). Training joins it; mid-session
  file edits behave like mid-session skill installs (next spawn / refresh
  hook `~/dev/duet-agent/src/session/session.ts:386`).
- Simplicity beats guard rails: prefer deleting an artificial restriction to
  scoping it (decision 6).

## Unknown unknowns — landmine cards

1. **Staging e2e hardcodes the workspace train journey.**
   `packages/test-harness/src/staging-e2e-synthetic:725-731`
   navigates `/train`, waits on a `trainJobId` and
   `train/jobs`+`train/records` responses. The journey survives (root path
   stays) but its assertions know the records rail's response shapes — file
   ops must keep list/detail response schemas compatible or the journey
   updates in the same slice. Local gates don't run it (code-review rule 25);
   close with `bun run e2e:staging`. **Sharp edge.**
2. **Synthesis runs in a jobs dir outside the drive** —
   `resolve(stateDir,'train','jobs',…)` (`gateway/src/train-runner.ts:65`), so
   the training agent itself inherits no trained memory and can't
   self-contaminate. Keep it that way when adding `--out`. **Sharp edge
   (good one — preserve it).**
3. **Two stale-reference sweeps ride along:** the training-complete email
   deep-links `/train` for every job
   (`packages/backend/convex/domains/train/model.ts:141`) → must carry the
   agent dimension; `duetfs train <ws> --url` (`packages/duetfs/src/cli.ts:104`)
   and the MCP train-upload tools (`packages/contract/src/mcp/index.ts:7`)
   stay root-agent-default and keep working — an `--agent` flag is a later
   nicety, not this spec. **Decided: root-default compatibility.**
4. **Convex `trainJobs` mirrors gateway phase reports**
   (`packages/backend/convex/schema.ts:941`) keyed by workspace+jobId —
   already N-job-safe, but rows need an `agentId?` for the per-agent jobs
   list and email link. Web query keys
   (`spa/api/query-keys.ts:106`) likewise gain the agent dimension. **Sharp
   edge.**
5. **Stale train rows keep getting recalled** on existing staging VMs (no
   migration): old `train`-tagged rows in root `memory.db` still rank into
   the recall pack alongside the new file layer. Accepted on staging;
   reprovision clears it. **Accepted.**
6. **Loader dir-name symmetry:** skills scan `.duet` > `.agents` > `.claude`
   per ancestor. The memory loader scans the same three names for `memories/`
   (zero new concepts); the product only ever writes `.agents/memories/`.
   **Decided.**

## Facts the builder must confirm before coding

- The exact frontmatter set the archive/UI needs (`headline`, `trainedAt`,
  `model`, `fileCount`, `sourceFolder`, archive id) against what
  `.duet-train.json` hands off today.
- The injected block's size cap value, and the refresh hook's behavior when a
  memory file is edited mid-session (piggyback skills re-discovery).
- Whether the drive file-view's dotfile hiding (viewer presentation,
  `gateway/src/routes/files.ts:792`) needs an exception or the Train UI is
  the sole window — recommendation: Train UI only, no exception.
- Store-budget details against `loader.ts`: the 15k-token cap uses the same
  `estimateTokens`, truncation drops oldest-first (newest survives), overflow
  warns on stderr and the Train UI surfaces it; the agent never fails to
  start over memory size.
- The outer `duet train` command's cwd (agent root → write target) vs. the
  inner synthesis agent's cwd (state-dir corpus → no memories discovered):
  confirm the inner spawn keeps the corpus cwd so self-contamination stays
  impossible.

## Build sketch — SUPERSEDED

The sketch that stood here became the real 13-slice ladder, now shipped;
see [README.md](README.md) — the closed record. The slice files were
collapsed at close.
