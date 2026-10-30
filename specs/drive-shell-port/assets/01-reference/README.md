# Drive V2 reference manifest

This manifest freezes the live source boundary used for the Duet cutover. It
is deliberately based on the mounted import graph, not neighboring prototypes.

## Revisions

| Repository   | Revision                                   | Role                                             |
| ------------ | ------------------------------------------ | ------------------------------------------------ |
| `chat-app`   | `bc9078fa94f243b65d94431fe62927c87408786c` | visual and information-architecture reference    |
| `duet-cloud` | `a9c9c7717f1043f6f5dc68e75555ffb37845752b` | implementation baseline after accepting the spec |

The reference entry point is
`apps/web/spa/drive-home/v2/route.tsx::DriveV2Route`. Its mounted graph is:

| Live section      | Source owner                                                                     | Mount evidence                                                        |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| shell and top bar | `drive-home/v2/route.tsx::DriveV2Shell`, `DriveV2TopBar`, `TabSwitcher`          | rendered by `DriveV2Route`                                            |
| Agents            | `drive-home/v2/agents-tab.tsx::AgentsTab`                                        | first `DriveV2TabPanel`                                               |
| Drive             | `drive-home/files-dashboard/files-dashboard.tsx::FilesDashboard`                 | mounted with `showRail={false}`                                       |
| Jobs presentation | `drive-home/v2/scheduled-jobs-tab.tsx::ScheduledJobsTab`                         | third `DriveV2TabPanel`; adapted to Duet Train                        |
| Integrations      | `integrations/route.tsx::IntegrationsRoute`                                      | fourth `DriveV2TabPanel`                                              |
| assistant         | `drive-home/v2/assistant/assistant-trigger.tsx` and `drive-assistant-drawer.tsx` | mounted outside Agents; omitted because Duet has no matching contract |

The Drive presentation owners followed from `FilesDashboard` are
`dashboard-toolbar.tsx`, `path-breadcrumb.tsx`, `miller-columns.tsx`,
`file-column.tsx`, `preview-column.tsx`, `file-viewer-overlay.tsx`,
`library-view.tsx`, `file-filter.ts`, `file-sort.ts`, `view-mode.ts`, and
`file-thumbnail.tsx`. The live route explicitly disables `widget-rail.tsx`.

The Integrations hierarchy follows `IntegrationsRoute` into
`components/hero-card.tsx`, `connected-apps.tsx`, and
`toolkit-browser.tsx`. `email-inbox-card.tsx` and
`workflow-focus-card.tsx` have no honest Duet contract and are omitted.

## Existing committed captures (negative scope evidence)

| Viewport | Reference file                                                                           | SHA-256                                                            |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| desktop  | `apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/drive-v2-overview.png` | `bab698a269320085c159e927b44d6e35a82d300366faa53152efba79e3ba1210` |
| mobile   | `apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/drive-v2-overview.png`  | `340fd5f284b8158087241cbc55ad589449b761b57fcd9d07aa1ca4268cf1ffdc` |

Both files are relative to the pinned `chat-app` revision. Inspection proves
that `drive-v2-overview` captures the neighboring `OverviewTab` prototype, not
the mounted `DriveV2Route`: desktop shows Discover/session/Files context and
mobile shows the campaign header. The hashes are retained as negative scope
evidence only and the images must not be used as shell-parity baselines.

The source registry marks the actual focused `drive-v2-shell`,
`drive-v2-drive`, and `drive-v2-integrations` fixtures `skipScreenshot: true`;
therefore no pre-existing binary is claimed for the live states. Candidate
screenshots are judged against the pinned source composition and interaction
contract, then linked from the final cutover report.

## Not-live reference material

The following neighboring owners are evidence only and do not expand the
product scope: `overview-tab.tsx`, `app-hosting-tab.tsx`, `chat-workspace.tsx`,
`agents-manager.tsx`, `workspace-agents.ts`, and mock-backed agent/superpower
catalog components. They are classified `NOT_LIVE_REFERENCE` or `OMITTED` in
the cutover ledger rather than silently mounted.

## Capture contract

Reference and candidate evidence uses 1440×900 and 390×844 viewports. Tight
crops may clarify hierarchy, but they never replace the full-frame capture.
Product routes consume only live Duet controllers; deterministic sample data
is confined to the playground/test seam.
