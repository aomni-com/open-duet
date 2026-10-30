# Drive V2 cutover report

_Status: live implementation ledger. Unfinished deeper Drive and Integrations
presentation work remains marked `TODO`; shipped shell/Agents/Jobs rows are final._

## Build identity

| Item                        | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Reference repository/commit | `chat-app@bc9078fa94f243b65d94431fe62927c87408786c`            |
| Duet repository/commit      | baseline `duet-cloud@a9c9c7717f1043f6f5dc68e75555ffb37845752b` |
| Cutover date                | 2026-07-16                                                     |
| Implementing branch/PR      | `walter/feat/frontend`                                         |
| API/backend diff            | must be none                                                   |

## Verdict vocabulary

- `PORTED`: reference information architecture/presentation brought across
  with only token/copy/data-hook substitution.
- `ADAPTED`: reference structure retained but changed to match a different
  real Duet contract.
- `OMITTED`: live reference behavior has no honest current Duet contract.
- `NOT_LIVE_REFERENCE`: source file/playground exists but is not imported by
  the live Drive V2 route.

## Summary

| Verdict            | Count |
| ------------------ | ----: |
| PORTED             |  TODO |
| ADAPTED            |  TODO |
| OMITTED            |  TODO |
| NOT_LIVE_REFERENCE |  TODO |

## Port ledger

Every row must link the exact source symbol, target owner, real Duet data
source, and reference/candidate evidence where visual.

| Reference section                              | Planned verdict    | Final verdict | Duet mapping / missing contract                         | Evidence                                                                          |
| ---------------------------------------------- | ------------------ | ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| full-bleed frame and panels                    | PORTED             | PORTED        | `DriveShell`                                            | [shell candidates](assets/02-shell/README.md)                                     |
| workspace switcher                             | ADAPTED            | ADAPTED       | current whoami/workspace transition                     | [shell candidates](assets/02-shell/README.md)                                     |
| centered accessible tabs                       | ADAPTED            | ADAPTED       | path-backed Agents/Drive/Jobs/Integrations              | [shell candidates](assets/02-shell/README.md)                                     |
| assistant trigger/drawer                       | OMITTED            | TODO          | no current assistant/scheduled-work contract            | [mounted assistant evidence](assets/01-reference/README.md#revisions)             |
| Agents 20rem rail/mobile drawer                | PORTED             | PORTED        | one `AgentsWorkspace` presentation owner                | [Agents candidates](assets/03-agents/README.md)                                   |
| default AI card                                | ADAPTED            | ADAPTED       | static Duet product identity; no fabricated API row     | [Agents candidates](assets/03-agents/README.md)                                   |
| installed-agent cards/count                    | OMITTED            | SHIPPED (agents-ui) | `AgentRosterRail` over the shipped agents entity; per-card sessions/apps, "Show all" without a count (D18), anchors over the reference's button callbacks, reused mask-image in place of `EdgeFadeScroll`, Discover omitted with no successor | [successor port](#successor-port--agents-ui-roster-rail-slice-06) |
| roles and skill chips                          | OMITTED            | SHIPPED (agents-ui) | derived from agent files, no contract change (D10): `role` = first non-heading `AGENTS.md` line, `skills` = `.agents/skills/` listing, via `apps/web/spa/drive/agent-profile.ts` | [successor port](#successor-port--agents-ui-roster-rail-slice-06) |
| Discover/Superpowers/install                   | OMITTED            | OMITTED       | source uses mock catalog; no Duet contract              | [not-live/mock owners](assets/01-reference/README.md#not-live-reference-material) |
| session rows/new-session/detail canvas         | ADAPTED            | ADAPTED       | current sessions list/detail/actions/SSE                | [Agents candidates](assets/03-agents/README.md)                                   |
| session-scoped files/messages from source mock | OMITTED            | TODO          | no session↔file relation                                | [`AgentsTab`](assets/01-reference/README.md#revisions)                            |
| agent-owned app rows                           | ADAPTED            | ADAPTED       | real Workspace Apps nested visually; no ownership claim | [Agents candidates](assets/03-agents/README.md)                                   |
| app detail/actions                             | ADAPTED            | ADAPTED       | current Apps controller/runtime actions                 | [Agents candidates](assets/03-agents/README.md)                                   |
| Drive control strip/filter/search/sort/views   | ADAPTED            | TODO          | current/open directory metadata                         | [Drive owners](assets/01-reference/README.md#revisions)                           |
| size sort and preview metadata                 | ADAPTED            | TODO          | Duet-only real `FileEntry.size`; reference lacks size   | [Drive owners](assets/01-reference/README.md#revisions)                           |
| URL filter/favicon thumbnail                   | OMITTED            | TODO          | no URL-file metadata/favicon contract                   | [Drive owners](assets/01-reference/README.md#revisions)                           |
| Miller columns and breadcrumb                  | PORTED             | TODO          | lazy `IFileSystemProvider.list` cache                   | [Drive owners](assets/01-reference/README.md#revisions)                           |
| preview column/full viewer                     | ADAPTED            | TODO          | current preview/editor/download owners                  | [Drive owners](assets/01-reference/README.md#revisions)                           |
| comfortable/compact density                    | PORTED             | TODO          | local presentation state                                | [Drive owners](assets/01-reference/README.md#revisions)                           |
| Library grid/list/split                        | ADAPTED            | TODO          | current folder only                                     | [Drive owners](assets/01-reference/README.md#revisions)                           |
| Library Everywhere search                      | OMITTED            | TODO          | no indexed recursive search contract                    | [Drive owners](assets/01-reference/README.md#revisions)                           |
| Drive widget rail                              | NOT_LIVE_REFERENCE | TODO          | live route passes `showRail={false}`                    | [mount evidence](assets/01-reference/README.md#revisions)                         |
| file mutations/sharing/activity/attribution    | ADAPTED            | TODO          | existing Duet capabilities retained in reference layout | [Drive owners](assets/01-reference/README.md#revisions)                           |
| Jobs table/detail silhouette                   | ADAPTED            | ADAPTED       | real sessions filtered by `status: "sleep"`             | [Jobs candidates](assets/10-jobs/README.md)                                       |
| cadence/next run/pause/agent owner             | OMITTED            | OMITTED       | absent from `SessionSummary`                            | [Jobs candidates](assets/10-jobs/README.md)                                       |
| scheduled-job editor                           | OMITTED            | OMITTED       | no schedule mutation contract                           | [Jobs candidates](assets/10-jobs/README.md)                                       |
| source staging and memory records              | ADAPTED            | ADAPTED       | existing Train utility nested beneath Duet              | [Agents candidates](assets/03-agents/README.md)                                   |
| Integrations hero/section rhythm               | PORTED             | TODO          | static UI + approved reference artwork                  | [Integrations owners](assets/01-reference/README.md#revisions)                    |
| connected-app roster                           | ADAPTED            | TODO          | current integration connections                         | [Integrations owners](assets/01-reference/README.md#revisions)                    |
| catalog/toolkit browser                        | ADAPTED            | TODO          | current catalog search/cursor/connect                   | [Integrations owners](assets/01-reference/README.md#revisions)                    |
| OAuth callback states                          | ADAPTED            | TODO          | current callback/invalidations                          | [Integrations owners](assets/01-reference/README.md#revisions)                    |
| email inbox manager                            | OMITTED            | TODO          | no inbox/channel/prompt contract                        | [omitted Integrations owner](assets/01-reference/README.md#revisions)             |
| workflow-focus/start-chat card                 | OMITTED            | TODO          | no workflow/progress contract                           | [omitted Integrations owner](assets/01-reference/README.md#revisions)             |
| `OverviewTab`/old chat workspace               | NOT_LIVE_REFERENCE | TODO          | not imported by live route                              | [not-live owners](assets/01-reference/README.md#not-live-reference-material)      |
| `AppHostingTab`                                | NOT_LIVE_REFERENCE | TODO          | concept represented by Workspace Apps                   | [not-live owners](assets/01-reference/README.md#not-live-reference-material)      |
| agent manager/workspace-agent prototypes       | NOT_LIVE_REFERENCE | TODO          | not imported; mock-backed                               | [not-live owners](assets/01-reference/README.md#not-live-reference-material)      |

## Duet-only real capabilities preserved

These are not reference verdict rows; they are current product contracts that
must survive the visual port.

| Capability                          | Target mapping                                  | Evidence |
| ----------------------------------- | ----------------------------------------------- | -------- |
| symlink entries/targets             | explicit opaque/symlink row in every Drive view | TODO     |
| file size                           | column/preview metadata and size sort           | TODO     |
| attribution, seen-by, and history   | preview/operation surfaces                      | TODO     |
| app-aware/phantom rows and repair   | Miller and Library entry projection             | TODO     |
| sharing and share landing           | Drive toolbar/dialog/route callbacks            | TODO     |
| workspace status/admin message      | new top-bar/workspace controls                  | TODO     |
| Cmd/Ctrl+number workspace switching | new workspace controls                          | TODO     |
| show-hidden toggle (default off)    | authenticated Drive toolbar; reveals leading-dot entries for listing only, reserved-path writes stay server-rejected | publish-viewer slice 03 |

The show-hidden toggle **supersedes** this spec's earlier "no hidden-files
toggle" invariant (README `### Drive`, slice 08 `## Work`). Reworking the
toolbar must preserve the toggle, not drop it.

## Route cutover

### Canonical routes

The route inventory is owned by the product destination registry and
`drive-routes` module. Agents maps to Sessions/Apps, Drive maps to Files, Jobs
has its own workspace leaf, and Integrations maps to its existing domain leaf.
Train is reachable only as a secondary Duet utility.

**Deep-link scope split (publish-viewer reconciliation).** The authenticated
Drive keeps folder/view state client-local with **no** URL deep links (the
wildcard stays unused). URL-synchronized deep-linking is owned solely by the
separate public `PublishViewerController` (publish-viewer slice 08); it must
never migrate onto the authenticated Drive.

### Deleted routes and chrome

`ProductShell` was deleted. `DriveWorkspaceShell` is the sole signed-in product
chrome, while settings/admin capabilities remain reachable without a selected
top tab. No classic/v2/fallback shell branch exists.

## API firewall

| Check                                   | Result | Evidence |
| --------------------------------------- | ------ | -------- |
| backend/Convex/gateway/contract changes | PASS   | scoped implementation diff contains none |
| generated API changes                   | PASS   | scoped implementation diff contains none |
| new network methods                     | PASS   | existing session and Apps clients only   |
| product mock/sample imports             | PASS   | none in the production owners            |
| test-only fixture boundary              | PASS   | playground data remains test-only         |

## Visual evidence

- Shell: [desktop/mobile candidates and critique](assets/02-shell/README.md).
- Agents: [desktop/mobile rail and Apps continuity](assets/03-agents/README.md).
- Jobs: [desktop/mobile scheduled-session candidates](assets/10-jobs/README.md).
- Deeper Drive/Integrations evidence remains pending with those presentation slices.

## Verification

| Command/gate                       | Result | Evidence |
| ---------------------------------- | ------ | -------- |
| focused behavior suites            | PASS   | Agents/Jobs/routes/shell/Apps/metadata suites |
| web `bun run test`                 | PASS   | behavior and boundaries green; ledger regenerated |
| `bun run check-types`              | PASS   | web TypeScript project                         |
| `bun run lint`                     | PASS   | repository lint; pre-existing warnings only    |
| route manifest                     | PASS   | manifest serialization test                    |
| Docker visual coverage             | BLOCKED| local Docker daemon did not respond             |
| compare-screenshots                | PASS   | reference/candidate rail comparison             |
| unprimed screenshot-critique       | PASS   | title wrapping and Train placement addressed    |
| route/workspace matrix             | PASS   | browser top tabs, rail, Jobs, Apps, mobile drawer |

## Remaining gaps

- Multiple installed agents, skills, and ownership groupings are **no longer
  this spec's gap**. The agent roster/relationship contract they required shipped
  with the [`agents`](../done/agents/README.md) feature on 2026-07-21, and the
  rail work is owned by [`agents-ui`](../done/agents-ui/README.md) — which replaces
  the single static Duet card with a real roster. Slice 03's stop condition
  fired and was escalated there rather than approximated here; do not re-open it
  in this spec. Discover remains omitted with no successor: its source is a mock
  catalog and Duet has no contract for it.
- Jobs cadence, next wake, pause/resume, owners, and editing remain omitted.
  They require those fields and mutations in the scheduled-session contract.
- The deeper reference Drive browser and Integrations presentation slices are
  still open; their existing real routes remain functional under the new shell.
- Docker baseline approval remains pending a responsive local Docker daemon.

## Successor port — `agents-ui` roster rail (slice 06)

The `installed-agent cards/count` and `roles and skill chips` rows above were
`OMITTED` at drive-shell-port time for lack of an entity. Their successor owner
[`agents-ui`](../done/agents-ui/README.md) has now ported the reference
`installed-agents-sidebar.tsx` into `apps/web/spa/drive/agent-roster-rail.tsx`
(`AgentRosterRail`) as a **fixtures-only** rail with its first Docker baselines.
Slice 07 then wired the roster to live data and deleted the old `AgentsRail`, and
slice 09 derived `role`/`skills` from agent files (D10, `agent-profile.ts`); the
two rows above are now **shipped**. This section records the port's non-literal
adaptations — the places a verbatim port would have been wrong for Duet:

| Reference symbol | Adaptation in `AgentRosterRail` | Verdict |
| --- | --- | --- |
| `sessionsExpanded` local `useState` per card | Consumer-controlled `expandedAgentId` / `onExpandedChange`, mirroring the todos `expanded`/`onExpandedChange` convention (`apps/web/spa/sessions/compose-session.ts`). "Show all" asks the consumer to activate the card and fetch its full paged list (D2/D13); it does not reveal a hidden local array. | ADAPTED |
| Global `sessionPreviewLimit = 4` | No limit in the component. The card renders whatever `sessions` array it is handed; the consumer's per-card query caps inactive cards and pages the active one (D13). Density settled at **3** by this slice's screenshot comparison. | ADAPTED |
| `app.icon: Icon` (Phosphor component) | Render slot `renderAppIcon(app)`, mirroring the reference's own `renderAgentAvatar`; Duet app icons are workspace images rendered by `AppIcon`. | ADAPTED |
| `onSelectSession` / `onSelectApp` on `<button>` | `<Link>` anchors with `aria-current`, preserving cmd-click and open-in-new-tab (single-owner invariant). Menu actions, which have no href in the props, route through one `onMenuAction(card, action)` callback. | ADAPTED |
| `EdgeFadeScroll` import | Reuses the existing inline `[mask-image:linear-gradient(...)]` treatment the current rail already uses on its apps strip; no second scroll-fade abstraction imported. | ADAPTED |
| Header **Discover** button (mock catalog) | Omitted; the header is a plain roster header (eyebrow "Agents" / "Roster"). Discover has no Duet contract. | OMITTED |
| Copy `showAllSessions(count)` | "Show all" carries **no number** (D18) — Convex pagination returns a page, not a total, and cards learn "more exists" from a `limit + 1` fetch. | ADAPTED |
| Copy "Default AI" / reference "Installed" | New `duetApp.agentRoster` keys in **both** locales (`en` + `es-419`, SE-5); the roster copy is a rewrite, not a reuse. | ADAPTED |
| Two card menu shapes | **Three** shapes (D21) keyed by a `menu: 'default' \| 'agent' \| 'replica'` prop: `default` (Open in Drive only), `agent` (Open in Drive/rename/share/delete), `replica` (Open in Drive/share) — mirroring the backend replica guard so shared-in agents never show a rename/delete that 403s. | ADAPTED |
| Default-card emphasis | D15's visual-gate variable, exposed as `defaultTint?: 'brand' \| 'flat'` (default `brand`) and settled to **brand** by screenshot comparison — the pinned default keeps quiet primacy over the agent cards. | ADAPTED |
