# Visual evidence manifest

These files preserve the visual standard used for the shipped Session and Jobs
work. They are provenance and diagnostic comparisons, not replacement golden
files. [`SHA256SUMS`](SHA256SUMS) pins every retained byte.

## Provenance

| Group | Revision | Meaning |
|---|---|---|
| Duet baselines | `6a1d489004bec58d0c4d272a1961bd881e7e3758` | Production-component playground before the refactor |
| `chat-app` references | `3389036ed12e71c917c20c30dea782930506d424` | Interaction and visual inspiration from the separately versioned `chat-app` repository |
| Reported screenshot | supplied 2026-07-19 | Original symptom: tool rows appear to inherit user authorship |

The repositories were clean when the files were copied. Source paths named
below for `chat-app` are relative to that repository root.

## Reference inventory

| File | Source | Requirement it established | Explicit rejection |
|---|---|---|---|
| `reported/session-event-grouping-dark.png` | User-supplied screenshot | Tools/reasoning need explicit Duet authorship and avatar rhythm | The unrelated dark shell was not a target |
| `baseline/duet-session-tool-expanded-{desktop,mobile}.png` | Duet `sessions-tool-expanded` | Existing Session composition and composer scale | Root-level tool/reasoning ownership was the defect |
| `baseline/duet-session-detail-ask-{desktop,mobile}.png` | Duet `sessions-detail-ask` | Whole Session composition and ask continuity | Flat part ownership was not preserved |
| `baseline/duet-session-message-success-{desktop,mobile}.png` | Duet `sessions-message-success` | Existing Message composer and successful-send state | It lacked the Follow up choice |
| `baseline/duet-session-note-success-{desktop,mobile}.png` | Duet `sessions-note-success` | Preserve distinct Note mode | Follow up remains absent from Note |
| `baseline/duet-jobs-{desktop,mobile}.png` | Duet `product-shell-jobs` | Preserve Duet shell, typography, and responsive scale | Sleep-only membership and one Waiting label were obsolete |
| `reference/chat-app-message-parts-{desktop,mobile}.png` | `message-parts-customer-report` | Quiet collapsed activity and nested ordered details | No schema, collapse-threshold, or avatar-grouping copy |
| `reference/chat-app-message-authorship-{desktop,mobile}.png` | `message-list.png`; desktop crop `x=200,y=2680,w=1040,h=650`, mobile crop `x=0,y=3900,w=390,h=900` | Duet/user/Duet avatar and header rhythm | Unread/date markers and same-author grouping were out of scope |
| `reference/chat-app-ordered-parts-collapsed.png` | `message-parts-customer-report.png`; crop `x=275,y=55,w=790,h=650` | Collapsed activity followed by final text | Long answer content was context only |
| `reference/chat-app-ordered-parts-expanded.png` | Same source; crop `x=275,y=710,w=790,h=1300` | Source-order reasoning/tool disclosure | Memory footer and exact rail tokens were out of scope |
| `reference/chat-app-relay-{desktop,mobile}.png` | `channel-relay-panel` | Compact current/progress hierarchy and bounded path disclosure | No state kinds, Convex ownership, or scheduler copy |
| `reference/chat-app-relay-compact.png` | Relay baseline; crop `x=120,y=1050,w=1200,h=600` | Resting priority under width pressure | Surrounding channel header was only a host |
| `reference/chat-app-relay-path.png` | Relay baseline; crop `x=120,y=190,w=1200,h=650` | Current-row emphasis in the retained path | The path is not execution history |
| `reference/chat-app-jobs-{desktop,mobile}.png` | `drive-v2-jobs-list` | Dense rows and mobile information shedding | Mock data was not lifecycle authority |
| `reference/chat-app-session-row-density.png` and `-mobile.png` | `sessions-list`; desktop crop `x=220,y=80,w=1000,h=410`, full mobile | Calm row hierarchy at wide/narrow widths | Transient statuses and model labels were not Duet Job semantics |

Pinned `chat-app` source owners:

- `apps/web/components/chat/message/primitives/message-parts-renderer.tsx`
  established ordered parts and nested disclosure.
- `apps/web/components/chat/message/implementations/main-message.tsx`
  established a message-owned shell while also showing the rejected same-author
  grouping behavior.
- `apps/web/spa/chats/components/channel-relay-header.tsx` established the
  compact priority ladder and desktop/mobile disclosure split.
- `apps/web/spa/chats/components/channel-relay-panel.tsx` established the
  bounded ordered path with current state emphasis.
- `apps/web/spa/drive-home/v2/scheduled-jobs-tab.tsx` was a preview mock used
  only for density and responsive hierarchy.

## Shipped comparisons

### Follow up composer

`comparisons/follow-up-composer/` preserves the frozen composer crop, shipped
production-owner result, side-by-side image, absolute difference, and metrics
from the `session-follow-up-control` pass. The production owner is
`apps/web/spa/sessions/session-composer.tsx`; the fixture and interaction gate
are `apps/web/components/playground/session-follow-up-control-playground.tsx`
and `apps/web/tests/visual/playground.spec.ts`. The accepted feature revision is
`b90f6a60ed346d24ca1bb07afcbf3fe4248acbb4`.

Desktop used the 1440×900/DPR 1 project and retained an 800×140 composer crop;
mobile used the 390×844/DPR 2 project and retained a 390×170 crop. Transcript
and header content were excluded. The shipped result changed only the labelled
accessory row without clipping or shifting the model bar, editor, avatar,
formatting action, or submit action. Diagnostic distance was `0.01681` desktop
and `0.02646` mobile. A fresh unprimed critique found no high-confidence
blocker, and the 58-case desktop/mobile visual gate passed. The exact locator
used for the standalone comparison crop was not retained, so these captures
are preserved evidence rather than a reproducible golden.

### Compact Relay status

`comparisons/compact-relay/` preserves before/shipped pairs for the Jobs and
Session hosts at 1440×900/DPR 1 and 390×844/DPR 2, plus side-by-side, absolute
difference, and metrics. The production owner is
`apps/web/spa/relay/relay-status.tsx`; focused coverage lives in
`apps/web/components/playground/session-relay-compact-playground.tsx` and
`apps/web/tests/visual/playground.spec.ts`. The accepted focused feature
revision is `78701b2e698f421f7f005597d47babf5a401db05`.

The comparison asked whether one backend-projected Relay status could add
current/progress meaning without colliding with either host. Unrelated shell
content and pixel parity with `chat-app` were excluded. The first candidate was
rejected because secondary fragments survived while current meaning clipped;
the corrected result passed an unprimed critique with no collision or hard
clipping. Diagnostic distance was `0.02823`/`0.02329` for desktop/mobile Jobs
and `0.02246`/`0.04489` for desktop/mobile Session. Exact whole-page locators
were not separately retained; the paired full-viewport captures and gate remain
the durable record.
