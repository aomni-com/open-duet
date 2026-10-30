# Drive V2 clean cutover

Port the live information architecture and visual composition of chat-app's
Drive V2 route into Duet as the workspace product. This includes the full-bleed
shell, centered tabs, Agents rail and canvas, Drive file browser, Jobs page,
Integrations page, and agent-scoped Train utility—not merely the outer navigation.

The rule is reference-first and truth-preserving:

1. Start from the live reference component and port its presentation directly.
2. Replace its data hooks with an existing Duet frontend contract.
3. Adapt labels or grouping when Duet's real model differs.
4. Omit a section only when no current contract can power it honestly.
5. Record every omission and material adaptation in
   [`CUTOVER-REPORT.md`](CUTOVER-REPORT.md).

No product mock data, backend work, new API, schema change, generated-API
change, route compatibility, or parallel shell is allowed.

## Next Agent Prompt

_Last updated: 2026-07-16 — shell, Agents rail, live canvases, and Jobs mapping complete._

Read this README and [`CUTOVER-REPORT.md`](CUTOVER-REPORT.md) fully, then start
with the independent pillar slices after [`02-shell-topbar.md`](slices/02-shell-topbar.md). Invoke
`write-tests` before each behavior slice and `ui-playground` before each visual
slice. Each visual candidate must pass `compare-screenshots` against the
feature-owned reference and an unprimed `screenshot-critique`. Offer
`preview-shots` as a non-blocking human checkpoint; wait about five minutes,
then record an evidence-based decision and continue if the user is silent.

Do not approximate a component from a screenshot when its reference source is
available. Copy the backend-independent presentation into its natural Duet
owner, strip reference hooks/state, and wire current Duet controllers. Never
import chat-app, Convex, or mock modules into the product runtime.

This is an atomic clean cutover. Controlled components may be proven in the
playground, but production has one shell and one route owner. The superseded
`ProductShell` is deleted rather than retained behind a mode or fallback.

**Next pickup:** continue the deeper Drive and Integrations presentation slices.
Keep product data behind existing Duet frontend contracts.

**Working-tree warning:** unrelated user changes already exist around
sessions/messages, visual tests, and generated/local files. Re-read
`git status`, preserve them, and coordinate overlap rather than rewriting it.

**Global TODO:**

- [x] 01 — reference import graph, captures, and truth ledger
- [x] 02 — full-bleed shell and centered top bar
- [x] 03 — Duet agent rail with real Sessions and Workspace Apps
- [x] 04 — real session and app detail canvases
- [ ] 05 — Drive toolbar, breadcrumb, filters, sorting, and view switch
- [ ] 06 — Drive Miller columns, selection, and preview
- [ ] 07 — Drive Library grid/list/split modes with honest search scope
- [ ] 08 — Drive mutations, sharing, activity, attribution, and edge states
- [ ] 09 — Integrations hero, connected roster, and catalog hierarchy
- [x] 10 — Jobs from scheduled sessions; Train nested under Duet
- [x] 11 — atomic shell cutover and removal of superseded chrome
- [ ] 12 — mobile, accessibility, localization, and overflow closeout
- [ ] 13 — refactor-clean, full product gate, and final cutover report

Update this section, the relevant slice, and the report ledger before ending
every implementation pass.

## Scope boundary: the live reference

The source of truth is the import graph of
`chat-app/apps/web/spa/drive-home/v2/route.tsx` at the pinned reference commit,
not every prototype in the same directory.

Mounted pillars:

- `AgentsTab`
- `FilesDashboard` with `showRail={false}`
- `ScheduledJobsTab`
- `IntegrationsRoute`

Mounted shell behavior:

- workspace switcher;
- Agents / Drive / Jobs / Integrations tablist;
- full-height tab panels;
- assistant trigger/drawer outside Agents.

`OverviewTab`, `AppHostingTab`, old chat workspaces, agent managers, and related
playground-only experiments are not live route pillars. Their concepts may map
into a live Duet surface, but they are classified as `NOT_LIVE_REFERENCE` in
the report rather than quietly expanding scope.

## Routing reality and clean cutover

Next.js hosts Duet, but `apps/web/spa/root.tsx` owns signed-in workspace routing
through React Router. The product destination registry and `drive-routes` own
the route inventory; do not create a competing Next.js App Router tree.

The signed-in SPA keeps one canonical route per existing domain. The shell
maps those routes into the new information architecture without aliases:

| Domain       | Canonical route                                      |
| ------------ | ---------------------------------------------------- |
| Agents       | `/w/:workspaceSlug/sessions` and session detail      |
| Apps         | `/w/:workspaceSlug/apps` and app detail              |
| Drive        | `/w/:workspaceSlug/files/*`                 |
| Jobs         | `/w/:workspaceSlug/jobs`                             |
| Train        | `/w/:workspaceSlug/train`                   |
| Integrations | `/w/:workspaceSlug/integrations`            |

Workspace/user settings and internal admin are real separate capabilities, not
compatibility routes. Keep them reachable from the top-bar account/workspace
menus while deleting the current product shell. The new chrome must preserve:

- workspace transition and creation;
- workspace settings and member/admin affordances;
- user settings, locale, and logout;
- status/offline state and admin message;
- `/w/:workspaceSlug/settings/*`, `/settings/*`, and `/internal-admin` access.

Render those authenticated utility surfaces inside the same `DriveShell`
chrome/content slot, outside the four tabpanels and with no falsely selected
tab. Do not retain `ProductShell` or create a second product shell just for
settings/admin.

One `drive-routes` module owns every Drive builder, matcher, active-tab rule,
title, workspace-switch target, and manifest entry. Switching workspaces keeps
only the pillar: Agents detail becomes Agents root, Jobs remains Jobs, and
Files/Integrations transient query state is dropped.

## No-mock and frontend-only firewall

“No mocking” means no fabricated data or fallback behavior in product runtime.
The repository's deterministic playground/test fixtures remain required test
infrastructure; they must mirror current wire shapes and can never be imported
by product routes.

Allowed:

- frontend routes, components, controlled view models, and local UI state;
- direct ports of backend-independent reference presentation/assets;
- widening the frontend-only `SpaApi` `Pick` for file methods already present
  on `DuetApiClient`;
- deriving display type/filter groups from real filenames/extensions;
- caching directory listings already fetched through `IFileSystemProvider`.

Forbidden:

- backend, Convex, gateway, shared contract, endpoint, or generated-API edits;
- new REST/RPC methods or response fields;
- product imports from chat-app or `@repo/backend`;
- `MOCK_*`, sample arrays, fake counts, fake relationships, or fallback rows;
- recursive client crawling presented as a complete indexed workspace search;
- schedule cadence/ownership, installed-agent rosters, skills, inbox, or
  workflow semantics without a real current contract.

## Shell and tab mapping

Desktop:

```text
workspace boundary
└── DriveShell (100dvh; one overflow owner)
    ├── DriveTopBar (48px)
    │   ├── workspace switcher
    │   ├── Agents / Drive / Jobs / Integrations
    │   └── real status + account/settings controls
    └── active panel
        ├── Agents: 20rem rail + flexible detail canvas
        └── Drive / Jobs / Integrations: full-width panel
```

Mobile uses the reference's 56px top bar, compact icon tabs, and a modal Agents
drawer. Preserve `tablist`/`tab`/`tabpanel`, roving `tabIndex`, Arrow keys,
Home/End, visible focus, reduced motion, Escape close, focus trap, and focus
restoration.

The reference assistant trigger/drawer is omitted, not replaced with an inert
control. Equal `flex-1 basis-0` side slots keep the tablist geometrically
centered while the right slot displays only real Duet status/account actions.

Tabs are path-backed. The third tab is **Jobs**. It projects the real session
list's scheduled state (`sleep`) and therefore does not invent cadence,
next-run timestamps, owners, or schedule controls. **Train** is an agent
utility linked from the Duet card, not a workspace-level top tab.

## Page-by-page information architecture

### Agents

Port directly:

- 20rem desktop rail, card/section density, edge-fade scrolling, selected-row
  treatment, new-session action, preview/expand behavior, divider, and mobile
  drawer;
- reference detail-header/canvas relationship for selected content;
- loading, empty, error, selected, and long-label states.

Adapt to real Duet data:

- render a **Sessions** section from the existing session list and cursor;
- render a sibling **Workspace Apps** section from the Apps query;
- render real session timelines/composer/actions and real app detail/actions;
- use loaded-page state for “load more”; never display an unavailable total.

Render one static product identity, **Duet**, as the workspace's default AI.
This is navigation copy, not a fabricated API entity. Nest the real Sessions,
real Workspace Apps, and Train entry beneath it. Do not imply installed-agent
counts, skills, Discover inventory, app ownership, or session ownership;
`SessionSummary.userId` is the initiating member, not an agent identifier.

The production projection lives with `AgentsWorkspace`; this document records
the ownership boundary rather than duplicating its changing prop shape.

### Drive

This is a UI port, not “mount the current Files page under a new tab.” Start
from these reference owners and adapt their presentation to the existing
`IFileSystemProvider` and current Files behavior:

- `files-dashboard.tsx`
- `dashboard-toolbar.tsx`
- `path-breadcrumb.tsx`
- `miller-columns.tsx`
- `file-column.tsx`
- `preview-column.tsx`
- `file-viewer-overlay.tsx`
- `library-view.tsx`
- file filter/sort/view-mode helpers and thumbnail presentation.

Port:

- 48px secondary control strip;
- Show filter, local search, name/modified/kind sort, a Duet-only truthful size
  sort, and view switch;
- breadcrumb anchored above the browser;
- lazy horizontal Miller columns with trail/selection states, depth fades,
  keyboard traversal, comfortable/compact densities, and long-path scrolling;
- preview column and full viewer using Duet's existing preview/editor/download
  capabilities;
- Library grid/list/split presentation for the open folder;
- real thumbnails when current download/read methods can produce them;
- loading skeletons, empty folders, errors, long names, and narrow widths.

Preserve and recompose every current Duet Files capability:

- upload and drag/drop;
- new file/folder;
- rename, copy, move, delete;
- share requests and share dialog;
- activity, attribution, seen-by, and history;
- app-aware folder rows, broken-app repair/navigation, and app-aware deletion;
- optimistic feedback, conflicts, notices, permissions, and downloads.

Truthful adaptations:

- listing metadata has filename, kind, size, and modified time but no MIME type;
  derive visual kind/filter group from the extension and use the content type
  returned when a file is read;
- the reference omits size sorting/preview metadata only because its file model
  lacks size; Duet has real `FileEntry.size`, so display and sort it and record
  the adaptation;
- the reference URL filter/favicon card is omitted because Duet has no URL-file
  metadata contract;
- preserve `file | directory | symlink` explicitly in the frontend entry
  projection. Never collapse symlinks out of the reference's two-kind tree;
- key thumbnail/cache identity by path plus current ETag (or avoid caching), not
  the reference's immutable file ID, because Duet writes in place;
- the authenticated Drive **does** offer a show-hidden toggle (publish-viewer
  slice 03, default off). This supersedes the earlier "no hidden-files toggle"
  invariant. Revealing leading-dot entries is a read-only listing convenience:
  it never weakens Duet's server-enforced reserved-path contract — writes to
  reserved `.duet` paths stay rejected server-side, and the public viewer can
  never request hidden-on (the gateway forces it off);
- search/filter counts cover the current/open loaded directory, not the whole
  workspace;
- Library offers an honest **This folder** search. The reference's
  **Everywhere** scope is omitted because there is no indexed recursive search
  contract;
- folder and view state remain local, as in the live reference route. Do not
  imply durable folder deep links with an unused wildcard URL. **Scope split
  (publish-viewer reconciliation):** this client-local, no-URL-deep-link rule is
  about the **authenticated** Drive and stays. URL-synchronized deep-linking
  lives only on the separate public `PublishViewerController` (publish-viewer
  slice 08) — never on the authenticated Drive, so neither spec misroutes a
  future agent into adding deep links here.

The reference widget rail is not part of the live Drive V2 tab
(`showRail={false}`), so it is not a missing port.

### Integrations

Port the reference page hierarchy rather than merely retaining Duet's current
card stack:

- page-width/max-width rhythm and generous vertical sections;
- gradient hero and the existing `duet-integrating.png` reference artwork if
  its repository provenance is acceptable for this project;
- icon-backed section headings;
- connected-app roster with actual logos/fallback marks, count, status,
  refresh, reconnect, and disconnect;
- dashed catalog/toolkit browser with search, responsive cards, connect
  actions, loading/empty/error states, and cursor-driven continuation;
- callback success/cancel/error presentation inside the page hierarchy.

Current `IntegrationCatalogItem` and `IntegrationConnection` fields power the
page directly. Preserve debounce, paging, OAuth, refresh/invalidation,
permission behavior, and disconnect confirmation.

Omit the reference's email-inbox manager and workflow-focus/start-chat card.
Duet has generic connection/catalog contracts, but no inbox rule/prompt,
channel, workflow requirement, deliverable, or workflow-progress contract.

### Jobs and Train

Jobs means sessions in the existing scheduled state. The frontend queries the
session list with `status: "sleep"` and links each row back to its real session.
The summary contract provides title, status, and activity time, but no cadence
or next wake time; the UI therefore says “Waiting to resume” and does not imply
schedule editing, ownership, or recurrence.

Train remains the existing source-staging and memory workflow. Root Train lives
inside the Duet card, while a registered agent's card links to its own scoped
Train surface. It is not a peer workspace pillar and is never selected in the
top tablist.

## API mapping

| UI need                 | Existing owner                              | Rule                                                     |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------- |
| workspace switch/status | whoami/workspace state                      | retain the sole workspace transition/access gate         |
| session rail/detail     | session data module                         | retain query keys, cursor, SSE, actions, and permissions |
| workspace apps/detail   | Apps controller/client                      | separate rail section; no agent ownership                |
| scheduled Jobs          | session data module with `status: "sleep"` | link real rows; omit unavailable schedule fields          |
| directory columns       | `IFileSystemProvider.list`                  | one lazy cache keyed by browser path                     |
| file preview/mutations  | current provider + preview/operation owners | presentation changes only                                |
| file sharing/activity   | current share/attribution owners            | recompose, never fork                                    |
| training runs/records   | current Train controller/client             | nested, scope-aware utility; preserve polling            |
| integrations            | current Integrations controller/client      | preserve cursor/search/OAuth semantics                   |
| status/settings/account | current shell actions/routes                | extract controls, delete superseded chrome               |

## One owner per concept

| Concept                                                  | End-state owner                                           |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Drive route grammar/tab metadata/workspace switch target | one `drive-routes` module                                 |
| workspace access and `transitionWorkspace`               | authenticated workspace boundary                          |
| viewport, top bar, panel selection, overflow             | `DriveShell`                                              |
| top-bar ARIA and keyboard behavior                       | `DriveTopBar`                                             |
| desktop rail/mobile drawer presentation                  | one controlled UI primitive                               |
| rail projection                                          | one SPA selector over session/Apps queries                |
| session lifecycle/query keys/SSE/actions                 | existing session data owner                               |
| session/app canvas presentation                          | one controlled surface per domain                         |
| directory cache/path chain/selection/view mode           | one Files browser state owner                             |
| file transport                                           | existing `IFileSystemProvider` / `RestFileSystemProvider` |
| file previews and operations                             | existing owners, recomposed into the new browser          |
| Jobs query and presentation                              | existing session list owner + one Jobs surface            |
| Train queries/actions/polling                            | existing Train controller                                 |
| Train presentation                                       | existing Train surface, linked beneath Duet               |
| Integrations queries/OAuth/actions                       | existing Integrations controller                          |
| Integrations presentation                                | one controlled Integrations surface                       |
| product test data                                        | existing typed playground fixture only                    |
| final port/omission truth                                | `CUTOVER-REPORT.md`                                       |

There is no `v2`, `classic`, `compat`, or fallback shell branch. The current
Files, Train, Integrations, Sessions, and Apps presentations are refactored or
replaced in place; no Drive-specific data controller duplicates them.

## Slice graph

```text
01 reference ledger
       │
       ▼
02 shell/topbar ─▶ 03 rail ─▶ 04 session/app canvases
       │
       ├──────────▶ 05 Drive controls ─▶ 06 columns/preview ─▶ 07 Library ─▶ 08 operations
       │
       ├──────────▶ 09 Integrations
       │
       └──────────▶ 10 Jobs + nested Train
                                      │
                                      ▼
                              11 atomic cutover
                                      │
                                      ▼
                              12 responsive/a11y
                                      │
                                      ▼
                              13 cleanup/report
```

Slices are backend-independent controlled surfaces or behavior-neutral
refactors proven in the existing typed playground. No blank panel or “coming
soon” state may land.

## Visual review map

Slice 01 archives fresh source images for all live pillars and the focused
component playgrounds under `specs/drive-shell-port/assets/`. Later slices do
not depend on mutable screenshots or code in the sibling repository.

| Slice | One visual variable                               | Crop/mask                                   |
| ----- | ------------------------------------------------- | ------------------------------------------- |
| 02    | shell/top-bar centering and height                | top strip; mask panel                       |
| 03    | rail width, hierarchy, density                    | left 20rem + divider; mask canvas/top bar   |
| 04    | rail-selection to detail-header/canvas continuity | Agents main pane; freeze rail               |
| 05    | Drive control-strip hierarchy                     | toolbar + breadcrumb; mask browser body     |
| 06    | Miller depth and preview proportions              | browser body; freeze toolbar                |
| 07    | Library grid/list/split composition               | one view mode per comparison                |
| 08    | mutation/notice/dialog feedback                   | one operation state per comparison          |
| 09    | Integrations vertical hierarchy/catalog density   | page body; mask global top bar              |
| 10    | Jobs list density + nested Train placement        | Jobs body and Duet-card crop                 |
| 11    | fixture-to-live parity                            | identical crops; no geometry change allowed |
| 12    | mobile compaction/drawer/overflow                 | one breakpoint and state per comparison     |
| 13    | holistic final shell                              | only after every isolated variable passes   |

Reference and candidate shots use at least 1440×900 and 390×844. Add 320px
overflow checks plus light/dark, English/Spanish, long content, loading, empty,
error, permission-denied, and reduced-motion states where the current contract
makes them reachable.

## Sacred contracts

- Workspace permission/access checks and `transitionWorkspace` run before a
  domain controller reads the active workspace.
- Settings, locale, logout, internal admin, workspace creation, status, and
  admin message remain reachable.
- Existing Cmd/Ctrl+number workspace switching remains reachable after the
  current shell is deleted; the behavior moves to the new workspace controls.
- Session query keys, cursor pagination, SSE, create/message/note/answer/
  interrupt/rename/archive/delete behavior remain singular and green.
- Visiting the new-session route creates no server session before submit.
- Apps registration/update/visibility/runtime/launch/delete behavior remains.
- Every current Files operation, share flow, preview/editor, app-aware rule,
  attribution/history/activity flow, conflict, and permission remains.
- Train source staging, quotas, scoped polling, completion invalidation,
  owned-record edit/delete, and inherited read-only behavior remain.
- Integrations search, pagination, connect/disconnect, OAuth callback, cache
  invalidation, loading/error/empty, and permissions remain.
- The shell has one viewport-height/overflow owner.
- No production page displays a field that cannot be traced to current API
  data, explicit local UI state, or static product copy.

## Verification harness

For each implementation slice:

1. invoke `write-tests` and prove the first tracer red before product code;
2. invoke `ui-playground` before visual TSX changes;
3. extend the existing typed SPA fixture rather than adding a second fixture
   API or source-repo provider;
4. run the narrow behavior/type tests;
5. run the Docker visual gate for affected IDs;
6. run `compare-screenshots` against the feature-owned reference using the
   slice crop/mask and record a less-wrong verdict;
7. run an unprimed `screenshot-critique` on every final image;
8. offer a non-blocking `preview-shots` checkpoint, then record the decision.

Final slice 13 gate from the repository root:

```sh
bun run test
bun run check-types
bun run lint
```

Also run the route-manifest/build-output checks, boundary checks, complete
desktop/mobile visual coverage union, and direct-load/back-forward/workspace-
switch matrix for every canonical route and OAuth/share return state.

## Final cutover report requirement

[`CUTOVER-REPORT.md`](CUTOVER-REPORT.md) is created now as the implementation
ledger and becomes the final user-facing closeout document. At completion:

- every live reference section appears exactly once as `PORTED`, `ADAPTED`, or
  `OMITTED`;
- unmounted source artifacts appear as `NOT_LIVE_REFERENCE`;
- every omission names the exact missing current contract and why a frontend
  substitute would mislead;
- every adaptation names the real Duet source fields and the visual/semantic
  deviation;
- every port links reference/candidate visual evidence and its target owner;
- the report records deleted routes/chrome, API-firewall evidence, final test
  commands/results, and unresolved gaps;
- no row remains `PLANNED`, `UNKNOWN`, or `TODO` when slice 13 completes.

## Stop conditions

Stop and add a report gap instead of expanding scope when:

- a desired element requires agent roster/skill/ownership, scheduled work,
  inbox automation, workflow progress, or global indexed file search;
- a surface cannot move without a backend/wire/schema change;
- asset provenance for reference artwork cannot be established;
- unrelated working-tree changes overlap an owner and cannot be preserved;
- visual review reveals that a different source route/sidebar was intended.

## Planning synthesis

The port keeps the reference shell/rail/file-browser/integration geometry while
using the existing Duet domain controllers. Unsupported semantics remain
explicit omissions rather than frontend inventions.

Decisions where drafts differed:

- Keep `/w/:workspaceSlug/drive/*`, not source-style org IDs or one query-tab
  URL; Duet's current slug seam stays direct and path-backed tabs give clean
  detail routes/OAuth history.
- Use a new sole `DriveShell` beneath the extracted workspace gate and delete
  `ProductShell`; do not add a full-bleed mode to the chrome being replaced.
- Render one static Duet product identity with real Sessions and Workspace Apps
  beneath it; do not manufacture an installed-agent data object.
- Port Library grid/list/split for the open folder, but remove the unbounded
  Everywhere scope.
- Label the third tab Jobs and derive it only from scheduled (`sleep`) sessions;
  keep Train nested under Duet.
- Preserve real settings/admin routes as capabilities, while deleting the
  superseded product navigation routes without aliases.
