# Agents — choices ledger

Every decision the implementation made on your behalf that the map/spec did not
dictate, stated at its **final shipped state** (verified against the code, not the
build plan). These are the architecture you now own — not bugs, just calls that
future work inherits. The user-made decisions themselves live in [`MAP.md`](MAP.md)
and are not repeated here.

All entries are **sound** (no redo needed). Ranked least-confident first — the
ones most worth a glance are at the top.

## Review these first

1. **Per-agent memory/logs are named by the anchor's id, not the agent's id.**
2. **A workspace is capped at 500 agents.**
3. **Deleting an agent leaves its memory and logs on disk forever.**

---

## The choices

### 1. Per-agent memory + logs are keyed by `anchorId`, not `agentId`
- **What it does today:** each agent's private memory database and log file live
  at `~/.duet/agents/<anchorId>/`. `<anchorId>` is the id of the *anchor* (the
  drive's per-path identity record — only anchored folders like apps/agents/shares
  have one; a plain folder has none), **not** the id of the `agents` row
  (`<agentId>`, a Convex document id). Both ids are immutable and both survive a
  folder move or a name change, so for those cases the two keys behave identically.
- **The concrete scenario where the key matters:** you register an agent at
  `agents/research`, chat with it (it builds up memory), delete the agent, then
  register a **new** agent at the same `agents/research` path. `deleteAgent` keeps
  the anchor, and re-registering **reuses** that same anchor (see #4) — so you get
  the same `<anchorId>` but a fresh `agents` row with a new `<agentId>`. Keyed by
  `anchorId`, the new agent **inherits the old memory**; keyed by `agentId`, it
  would start blank. Delete-then-recreate-at-the-same-path is the *only* case where
  the two keys diverge.
- **The gap it filled:** the map said "per-agent" without pinning which id names
  the directory (its prose loosely implied `<agentId>`).
- **The reach:** a *shared* agent's replica gets the recipient's own fresh anchor,
  so replicas always start with empty memory regardless (nothing crosses
  workspaces). The one behavior you now own: re-registering at a used path
  resurrects memory. If you'd rather delete-then-recreate always wipe memory,
  switch the key to `agentId`.
- **Confidence: medium** — reasonable and consistent with "anchor owns identity,"
  but it's a real identity scheme you might have wanted keyed differently.

### 2. A workspace may hold at most 500 agents (`MAX_AGENTS_PER_WORKSPACE`)
- **What it does today:** registering the 501st agent in a workspace is rejected
  ("Workspace agent limit exceeded"); the same ceiling bounds how many replicas a
  shared agent can fan out to.
- **The concrete scenario:** automation that mints an agent per project could hit
  the wall at 500. The number 500 was chosen to mirror the existing
  `MAX_APPS_PER_WORKSPACE`, not from an agents-specific rationale.
- **The gap it filled:** the spec named no cap; without one, session creation and
  replica fan-out would scan an unbounded set.
- **The reach:** it's the product limit on "how many agents." Changing it is a
  one-line constant edit, but every place that bounds a scan reads it, so the same
  number governs both registration and fan-out.
- **Confidence: medium** — a sound default, but the specific value is a product
  call you own.

### 3. Deleting an agent leaves its memory + logs on disk (no garbage collection)
- **What it does today:** deleting an agent removes its database row and preserves
  its anchor (#4), but the gateway **never** removes `~/.duet/agents/<anchorId>/`.
  The memory DB and logs stay on the VM's disk indefinitely.
- **The concrete scenario:** you create and delete 100 throwaway agents; 100
  memory directories remain under `~/.duet/agents/`. Nothing reclaims them.
- **The gap it filled:** the map said "leave the dir (supports un-delete)" as a
  hand-wave; the implementation made it literal — no cleanup path exists.
- **The reach:** it's why re-registering at the same path resurrects memory (a
  feature — see #1), but it also means disk grows monotonically with churn on a
  fixed-size (~2 GB) VM. Note the two are in **direct tension**: GC'ing the dir is
  exactly what would break resurrection, so this is an inherent tradeoff of the
  feature, not a free "add a cleanup" fix. Reclaiming disk means giving up
  resurrection (or adding an age/`lastUsed`-based sweep that only reaps dirs whose
  anchor is long gone).
- **Confidence: medium** — deliberate and matches the un-delete intent, but the
  unbounded-disk-vs-resurrection tradeoff is a policy you now own.

### 4. Deleting an agent removes only the row — the anchor is left orphaned, un-GC'd
- **What it does today:** `deleteAgent` deletes the `agents` row and nothing else —
  it does **not** delete the anchor (it reads it only to record the deleted path in
  the audit event). The anchor stays behind as an orphan (`kind:'agent'`, still
  `active`, with no row pointing at it), and its `.duet-anchor` marker file stays
  on the folder. Your folder and files are untouched. This is byte-for-byte how
  `deleteApp` behaves.
- **The concrete scenario:** you register and unregister 100 throwaway agents.
  Convex now holds 100 orphan `agent` anchors (plus 100 marker files on disk, plus
  the 100 memory dirs from #3). Nothing reclaims them — entity anchors are never
  deleted in the anchor model; the only lifecycle transition is being marked
  `broken` (a patch, not a delete) if the *folder* later vanishes. An orphan anchor
  persists until you re-register at that path (it gets reused) or you delete the
  folder itself.
- **The gap it filled:** the map's #16 ("default agent = absence, no migration")
  implied delete should be non-destructive but didn't specify anchor lifecycle.
- **The reach:** reusing the preserved anchor on re-registration is what makes #1's
  memory-resurrection work. Two consequences follow, and they need *different*
  fixes — do not conflate them:
  1. **Disk accumulation (inherent tradeoff, not a bug to fix).** The orphan anchor
     + marker + memory dir sit on disk with no GC. But GC is fundamentally at odds
     with resurrection: deleting them (or deleting the anchor, which mints a new
     `anchorId`) is exactly what would make #1 *stop* resurrecting memory. So you
     cannot both keep resurrection and GC these; keeping them is the price of the
     feature. (An earlier draft of this entry wrongly recommended "GC-on-delete" —
     that would have silently killed #1.)
  2. **Kind-lock (a real gap, cleanly fixable).** Because the orphan is left with
     its original kind and an anchor's kind is fixed at creation, once a folder has
     been an app you **cannot** later register it as an agent (or publish) at the
     same path — `getOrCreateAnchorForPath` throws `"Anchor path is not an agent
     anchor"` (agent registration only accepts an existing `share-root`, never
     `app`/`publish`). Today: re-register it *as an app* (works) or make the agent
     at a different path. `app`/`agent`/`publish` are mutually exclusive per path;
     only `share-root` is a compatible cross-kind. This is a pre-existing
     anchor-system property agents inherit. **The clean fix (unbuilt) is an
     `orphaned` anchor *state*:** unregister sets `state:'orphaned'` instead of
     leaving it `active`; the single adoption gate `getOrCreateAnchorForPath`
     treats an orphaned anchor as claimable by *any* kind (adopt, set the new kind,
     re-activate). That keeps `anchorId` (so #1's resurrection still works) while
     freeing the kind — and it never permits two live entities, since orphaned = zero
     entities. It is a cross-cutting anchor-model change (apps/publishes/agents
     alike, plus rename-detection + the files-browser projection learning to treat
     `orphaned` as "no live entity"), which is why it wasn't in this feature's scope.
- **Confidence: high** — mirrors how apps already treat anchors; the disk tradeoff
  is inherent to resurrection and the kind-lock has a clean unbuilt fix, both now
  yours to weigh.

### 5. A session's agent is bound at first launch; a vanished agent fails closed
- **What it does today:** the gateway records which agent a session resolved to
  (`agentAnchorId`) in its durable envelope on the first launch, and re-uses it on
  every respawn. If the agent row is later deleted but the anchor remains, the
  session keeps running with its anchor-keyed memory. If the anchor itself is
  entirely gone (the folder was deleted mid-session), a respawn **throws** rather
  than silently falling back to the default agent.
- **The concrete scenario:** a long-running session is executing under
  `agents/research`; someone deletes that folder. On the next respawn the gateway
  refuses ("Bound agent anchor is unavailable") instead of quietly restarting the
  session as the default agent with different memory/prompt.
- **The gap it filled:** the spec didn't say what happens when a running session's
  agent disappears.
- **The reach:** favors "loud failure" over "silent behavior change." Consistent
  with the fact that a deleted `cwd` directory already makes launch fail.
- **Confidence: medium** — the safe choice, but "fail closed" vs "fall back to
  default" is a genuine behavioral fork.

### 6. A bad `agent.json` warns *ephemerally* — it's not in durable session history
- **What it does today:** if an agent's `agent.json` is malformed, the session
  starts anyway in `auto` mode and the gateway emits one `system`/`warn` event into
  the **live** stream plus one line into the agent's log file. That warning is
  **not** persisted into the Convex session/Jobs history.
- **The concrete scenario:** overnight, an agent's config is broken. The session
  ran fine (in auto). In the morning you open the session in the UI — there's **no**
  record of the warning there; the only durable trace is
  `~/.duet/agents/<anchorId>/logs.log`.
- **The gap it filled:** the map said "warn," not "where the warning is durable."
- **The reach:** to surface config problems after the fact, read the per-agent log,
  not the session timeline. If you want config warnings in Jobs history, that's a
  separate decision.
- **Confidence: medium** — matches how other transient runner warnings behave, but
  "not in history" may surprise.

### 7. The per-agent log is rewritten whole-file on every append, capped at 10k lines
- **What it does today:** each log write reads the existing file, keeps the newest
  10,000 lines, writes them to a temp file, and atomically renames it into place —
  serialized per path.
- **The reach:** crash-safe and self-trimming, correct for warning-frequency
  writes; it is *not* a high-throughput append log (rewriting the whole file per
  line would be wrong for a chatty log). Fine at the intended volume.
- **Confidence: medium** — right for the use, worth knowing it's not built for
  high write rates.

### 8. The default (drive-root) agent is pure absence — it never reads a root `agent.json`
- **What it does today:** a session at the drive root resolves to no agent, so the
  gateway passes no `--system-prompt-file` and never reads a `drive/agent.json`; it
  runs `auto` with the root observational memory DB and the root curated-memory
  store. Its launch identity and prompt behavior remain the pre-agents path. A
  `drive/AGENTS.md` still works, because the underlying CLI reads `AGENTS.md`
  from its working directory on its own.
- **The reach:** you can customize the default agent's *prompt* via
  `drive/AGENTS.md`, but you cannot give the default agent a *forced mode* by
  dropping a `drive/agent.json` — forced mode requires a registered agent.
- **Confidence: high** — this is what keeps every existing session unchanged.

### 9. Share replication is one generic driver; apps and agents are adapters
- **What it does today:** the shared-folder replica convergence logic lives once in
  a neutral module (`domains/replication/shared.ts`), with `app` and `agent`
  adapters supplying only entity-specific row operations and collision-suffix
  policy. The `[app, agent]` list is the single thing accept/revoke/unlink iterate.
- **The reach:** a future shared resource (beyond apps and agents) plugs in as a
  third adapter without touching convergence. This is why there is no parallel
  `agents/replication.ts`.
- **Confidence: high** — the explicitly-intended single-owner architecture.

### 10. `createdByUserId` is a required field on every agent row
- **What it does today:** each `agents` row records the user who created it (used as
  the actor when the replica's anchor + audit events are written).
- **The reach:** a schema field every agent carries; provenance for shared-agent
  audit trails.
- **Confidence: high** — mirrors app anchor authorship.

### 11. Register/update/delete surface a gateway-push failure as `502 agent_reconcile_failed`
- **What it does today:** the agents write endpoints wait for the gateway to accept
  the new anchor set (so a session started immediately after registration resolves
  correctly). If that push fails, the API returns HTTP **502** with code
  `agent_reconcile_failed`; retrying the same request is idempotent.
- **The reach:** clients must treat a 502 here as "retry," not "server broken."
- **Confidence: high** — mirrors the apps reconcile-push contract.

### 12. Session→agent attribution details (resolution + read shape)
- Nearest-agent ranking normalizes paths through the drive grammar
  (`normalizeDrivePath`), picks the deepest exact-or-ancestor match, excludes
  sibling-prefixes (`agents/rev` does not match a cwd under `agents/reviewer`), and
  returns the default agent at the drive root.
- The resolved agent is snapshotted onto the session as `{ agentId, agentName }`
  (`agentName = name ?? slug`) at creation and is immutable — later renames/deletes
  never rewrite a past session's attribution.
- **Confidence: high** — direct realizations of map decisions #6/#8.

### 13. CRUD surface mirrors apps
- Agent list sorts by slug ascending; `PATCH` changes only `name`/`icon` and cannot
  null-clear them (omitted = unchanged); `DELETE` is idempotent; viewers may list,
  editors may register/rename/delete; the anchor registry applies VM anchor
  snapshots serially with atomic replacement; the gateway session envelope stays
  serialization version 1 with an optional `agentAnchorId`.
- **Confidence: high** — all faithful mirrors of existing app/anchor conventions.

---

Trivial discretion not itemized (internal naming, cosmetic calls): the
`manage-agents` skill's `{workspaceSlug}` placeholder and inline example, the exact
warning wording, agent audit-event names, the `protectAppAnchors →
protectManagedAnchors` rename, string-normalized ids at the driver boundary, and
the optional `anchors` dependency-injection on the gateway controller.
