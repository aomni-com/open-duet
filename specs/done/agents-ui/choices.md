# Agents UI — consolidated choices ledger

Every decision made where the spec was silent, re-audited against the final
shipped code at close. This is the review surface for what was decided without
you: entries are grouped by verdict and ranked least-confident-first within
each group. Gate results and run evidence live in the closed README and git history, not here.

## Needs your eyes (taste or semantics you may want to change)

1. **A failed post-deletion sync no longer blocks agent deletion.** Deleting an
   agent does three things: stop its runners (gateway), delete the row
   (Convex), and push a config re-sync to the VM. The re-sync used to be
   fatal — but it runs *after* the deletion has committed, so a paused
   workspace got a 502 for a deletion that had already happened and could
   never be retried (the agent was gone). The re-sync is now fire-and-forget;
   the gateway re-syncs anchors on resume anyway. Correct, but it means a
   reconcile failure is no longer surfaced to the caller.
   (`apps/api/src/routes/agents.ts`)

2. **Deleting a shared agent stops only direct replicas, in their own
   workspaces.** When you delete an agent that was shared to other workspaces,
   each recipient's replica sessions are terminalized in that recipient's
   workspace — but only one level deep (agents re-shared from a replica are
   not chased), and no cross-workspace runner teardown is attempted (each
   workspace's own gateway owns its processes). If re-share chains become a
   real pattern, this needs a second look. (`domains/agents/model.ts`)

3. **"Open in Drive" lands on the Drive tab root, not inside the agent's
   folder.** The Drive surface keeps its current path in component state and
   ignores the URL, so deep-linking to the anchor folder would require making
   it URL-aware — real surgery, deliberately not smuggled into this feature.
   If you want folder deep-links, that's a small follow-up feature.

4. **The Jobs agent filter puts the agent's id in the URL, not its slug.**
   `?agent=<id>` round-trips into the request with zero resolution. A slug
   would read nicer in a shared link; an id survives renames. Either is
   consistent; the shipped one is the id. (`apps/web/spa/routes/jobs.tsx`)

5. **An agent's profile reads degrade independently, not jointly.** The slice
   text said any failed file read yields `{skills: []}`. As shipped, a missing
   `AGENTS.md` doesn't discard the skills listing and vice versa — most agents
   have one but not the other, and collapsing both on one 404 would blank the
   common case. The floor (both fail → empty profile, no error UI, health
   pill untouched) still holds. A deliberate deviation, flagged as such.
   (`apps/web/spa/drive/agent-profile.ts`)

6. **Roster copy: header reads "Agents / Roster", Spanish "Agentes / Equipo".**
   New keys in both locales (the old rail said "Default AI"). Pure copy taste;
   thirty-second change if you want different words.
   (`apps/web/messages/*/app.json`, `duetApp.agentRoster`)

7. **The detail page shows health as a quiet dot + pill, not app-detail's
   banner.** A read-only page keeps status low-key; the shots are in
   [`assets/`](assets/) if you want to re-judge.

## Sound — architecture and contracts (verified against shipped code)

8. **Agent scope rides the existing query trees as a parameter.** Two new
   Convex indexes (`by_workspace_agent_archive_job_view[_status]_updated`),
   `agentId` as the sixth search filter field, and one `agentScope()` helper
   inside the existing branch tree — never a second query function. The wire
   accepts `agentId: 'root' | <id>`; the Convex boundary validates it as
   `v.union(v.literal('root'), v.id('agents'))`.
9. **`agentId` + `archived:'include'` is rejected twice.** A contract-level
   400 *and* a re-throw in the query impl, so the unindexed combination can
   never silently fall back to an unscoped scan (that would be a data leak
   wearing a filter's clothes).
10. **One terminalization sweep, parameterized three ways.** Workspace pause
    and agent deletion share `continueSessionTerminalizationForScope`
    (candidate source, guard, reason); batch size 8 / 250ms continuation kept
    from the pause sweep; the agent guard is unconditional because a deleted
    row can't un-delete. Agent deletion passes `allowPaused: true` so paused
    workspaces stay cleanable.
11. **Runner teardown reuses the session-delete machinery.** The gateway's
    `discardAgent(agentAnchorId)` walks the envelope ledger and calls the
    existing per-session `discard()`; the API route calls the gateway first
    and fails closed (502, nothing deleted) when it's unreachable. The route
    asserts mutability *before* the teardown leg, so a direct-API replica
    delete can no longer kill runners and then 403.
12. **The session cache learned the agent dimension in its key AND matcher
    together.** `agentId` is an optional field inside the existing filters
    object (unscoped keys byte-identical — zero cache churn), and the matcher
    folds `summary.agent?.id ?? 'root'`, mirroring the backend's narrowing —
    the same rule on both sides of the wire.
13. **Each roster card owns its own infinite query.** Per-card components
    (not `useQueries`, which has no infinite variant) keep hook order stable
    and keep every card list under the standard cache key the matcher files
    into. The rail itself renders props only; the cross-surface card/menu
    vocabulary lives in `agent-roster-types.ts`, and behavior in one
    `useAgentActions` hook shared by card and detail.
14. **"Show all" expands the card in place** (single `expandedAgentId`), all
    cards fetch `previewLimit + 1` as count-free lookahead, preview limit 3 —
    settled by slice 06's screenshot comparison, like the default card's brand
    tint (the tint prop itself was removed at consolidation; brand is
    unconditional).
15. **Search mode unmounts every scoped card** and runs one unscoped query
    (200ms debounce, instant clear); no component branches on `search.length`
    — the hook hands the rail a discriminated union.
16. **Profile derivation is deterministic and cheap.** Role = first prose line
    of `AGENTS.md` (frontmatter/headings/comments skipped, blockquote/list
    markers stripped, CRLF safe); skills = one directory listing, order
    preserved, no per-entry confirmation reads; 5-minute `staleTime`, two
    requests per agent, lazily per card; the detail canvas reuses the same
    cache.
17. **The detail canvas resolves from the cached list** (no GET-by-slug),
    parses `agent.json` with the gateway's own rule (missing/malformed →
    `auto`), and reads the raw `AGENTS.md` as its own cached query — one
    accepted extra read on the detail surface.
18. **Session create sends `cwd`, never `agentId`.** The picker (default +
    launchable agents only) computes `cwd` from the selection; the no-agent
    path is byte-for-byte the pre-feature request (pinned by test); an
    unknown/ineligible `?agent=` renders an unavailable state, never a silent
    root session. The `+ New agent` prompt rides router state so the URL stays
    clean.
19. **Rename is optimistic with exact-snapshot rollback; delete is not
    optimistic** — it waits for the fail-closed result, keeps the card on 502,
    and offers retry inline. Attribution chips render from the immutable
    creation-time stamp, so a deleted agent's history keeps its name while the
    filter offers only living agents.
20. **Link-back branches in one pure function.** `sessionLinkTarget` resolves
    against the origin; only exact-origin URLs navigate in-SPA (stripped to
    path+search+hash); everything else — external, protocol-relative,
    `mailto:`, unparseable — opens externally. Both markdown call sites use
    it; `@repo/ui`'s `Markdown` stays product-agnostic. The `manage-agents`
    skill now ends creation by emitting the root-relative link, with a test
    pinning the link's presence and codegen byte-stability.
21. **Roster freshness is a per-slug-per-mount `Set`** keyed on
    `isSuccess` (an errored roster is never evidence of absence): one
    invalidation per unknown slug, never a loop, nothing for known slugs.
22. **The rename slice's true scale was 64 goto strings and 97 baselines**
    (the map's 57/95 undercounted); all renamed via `git mv` at 100%
    similarity, zero drops; the drive-shell-port cutover ledger rows flipped
    to `SHIPPED (agents-ui)`.
23. **The `Duet` display identity has one owner** (`agent-display.ts`:
    `DEFAULT_AGENT_NAME` + `agentDisplayName`), deliberately SPA-level — the
    map rejected a contract-level display adapter, and the server keeps its
    own naming rule in its model.
24. **The staging journey asserts VM runner death only where it can be
    honest.** The e2e container has no SSH path to the VM, so the
    present→absent `pgrep` proof is reachability-gated (recorded as
    `unreachable`, never silently passed) while the in-band proofs — live
    runner before delete, fail-closed 200, convergence to
    `interrupted/agent_deleted`, no active job, immutable history attribution,
    ghost-free roster — run everywhere. The roster leg asserts the agent-list
    contract (the harness is API-level, not a browser). After the first live
    run: the scoped-session-list proof uses a **plain session** (the hold
    session is a job, and the rail list filters `jobView === undefined` by
    design), and the journey now also pins that the job does NOT leak into the
    rail list.

## Fixed environment/process facts worth keeping

25. **Two pre-existing codegen drifts were repaired en route** (backend
    `_generated/api.d.ts` missing seven landed modules; skills-registry
    `generated.ts` never re-committed after an oxfmt post-processing change) —
    both are idempotence-proven now.
26. **The spa-shell playground clock is frozen** (`FIXTURE_NOW` through the
    existing injectable attribution clock) — its relative-time baselines were
    rotting every wall-clock day; surfaced by the rename slice's zero-pixel
    check.
27. **The Train page's entry point was restored** (Brain icon in the roster
    header, same icon/target/label as the pre-cutover rail) after the cutover
    orphaned it — found because slice 08's migration refused to paper over it.
28. **The publish-viewer's missing origin is a typed config default, not a
    provisioned env var** — the user chose the config.ts route; the details
    were the integrator's: keyed on `VERCEL_ENV` (never the inbound Host, per
    the feature's R4), preview/dev fall to the staging origin (staging is the
    single non-prod config), `DUET_WEB_ORIGIN` remains the per-env override,
    and the interim `valueFrom: 'DUET_APP_URL'` topology row was fully
    reverted (no var was ever applied to any project — verified in the fanout
    logs). Two diagnostic e2e runs used a disclosed, uncommitted harness patch
    (publish failure recorded as a leg-fail instead of aborting) — reverted
    both times; the committed gate is unweakened.
