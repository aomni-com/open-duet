# Backups Settings verification

The owner enters `/w/:workspaceSlug/settings/backups` from the Backups tab, immediately after Shares in the navigation.
General Settings contains no backup card. Owners retain access to the Backups
route while the workspace is paused or archived; other workspace routes keep
their execution gate. The billing wall's recovery link targets Backups directly.

## Evidence

- `backups-tab-desktop.png` and `backups-tab-mobile.png` show the production
  Settings route through the deterministic API fixture. Capture waits for the
  outgoing General page to disappear, so transition residue is excluded.
- `backup-states-{desktop,mobile}.png` show empty, capturing, uploading, ready,
  partial, failed, deleting, and archived recovery states. The warning crops
  show action placement and partial-capture disclosure at double scale.
- `settings-before-*`, `settings-after-*`, `settings-comparison-*`, and
  `settings-diff-*` compare the real General route before and after adding the
  navigation tab. They demonstrate the navigation change, not the backup card.
  The pixel comparison records 1,670 changed desktop pixels (0.129%) and 299
  changed mobile pixels (0.023%). `settings-visual-metrics.json` is the raw result.
- Docs crops cover the workspace export explanation and generated endpoint
  reference, including the mobile code block and opaque-cursor contract.

## Findings addressed

The first unprimed critique found no blocking layout defects. Its error-text
contrast concern matched direct inspection: failed-capture text now uses dark
red in light mode. The existing mobile Settings navigation occupies substantial
vertical space but does not cover controls. Direct inspection also caught a
mobile docs Copy button overlapping a one-line JSON example; the example now
uses multiple lines. Moving to a dedicated tab removed a duplicated card title
and description that the page header already supplied.

Independent Codex review found that concurrent downloads could lose the earlier
per-call mutation callback. Each download now owns its `mutateAsync` continuation.
The browser regression fails before the change (two grants, one download) and
passes afterward (two different downloaded grants), on desktop and mobile.
A second review caught two journeys still navigating to General; both now
navigate to Backups and the browser journeys pass.

## Behavioral checks

The browser exercises creation, leaving and returning to durable capture,
fresh downloads, explicit deletion confirmation, deletion convergence, failed
capture retry, reuse of a request ID after a lost response, overlapping downloads,
and recovery access from a paused workspace's billing wall. An SSR test proves
that Backups owns the card and General does not. The polling test was falsified
by disabling polling, then passed after restoration.

The web package passed 1,904 tests plus boundary and visual-owner checks. Docs
passed its package checks, including the 163-endpoint ledger. Contract endpoint
registry tests passed. The expanded Docker screenshot check passed 60 web and 4 docs cases. After the
final navigation reorder, the scoped snapshot pass passed all 48 affected web
cases, including full-page captures and lifecycle interactions.

## Final visual acceptance

A fresh unprimed reviewer inspected the dedicated-tab desktop/mobile captures,
state montage, warning crops, and docs. The parent also inspected the candidate.
Neither found clipping, overlap, or a new Backups defect. The existing mobile
Settings navigation occupies about 38% of the viewport, and the existing shell
header icons lack explanatory labels. These shared-shell concerns are accepted
for this pass rather than expanding the feature into navigation redesign.
The inset mobile docs code block wraps variables, but remains readable and its
Copy action preserves the source. That is a minor documentation presentation
limitation, not a blocker. The candidate is visually accepted.

## Screenshot scope

The expanded fixture journey also recaptured unrelated scenes. Marketplace
refetch's mobile image changed 346 raw pixels and zero perceptual pixels at a
0.1 comparison threshold. The training upload error image changed only rounded
edge rasterization and its last crop row (332 perceptual pixels), with unchanged
content and layout. Those images, and an equivalent zero-perceptual-pixel
entitlement-wall image, were restored rather than including capture noise.

Six user Settings images (profile error, non-payer billing, and one-time API-key
secret, in both viewports) had stale baselines predating the existing shared
SettingsFrame redesign in commit 4d05139b7. Their refresh showed its Back to
workspace link and sans-serif headers, not a backup change. Those unrelated
baseline refreshes were also excluded. The expanded gate result above describes
the captured candidate before those scope exclusions; rerunning that broad
journey against the retained historical user Settings baselines can expose the
pre-existing drift. Workspace Settings images retain their updates because the
new Backups navigation entry is visible there.

## Interface review and decisions

The current API branch's create, list, status, download, and delete routes match
the client's methods and response schemas. Create accepts a request ID and
returns a durable record with 202; delete can return 202 with deletion pending;
list carries an opaque cursor; download mints a fresh expiring URL and archive
metadata. New internal backup control exports do not alter these browser seams.

The owner-only card keeps unfinished jobs polling while mounted and resumes
from durable list data after navigation. Failed request acceptance reuses the
request ID; a failed capture starts a new attempt. Signed download grants never
enter backup records or query data. Partial captures remain downloadable with
warnings, and deleting an archived recovery archive explains an empty Drive on
next start. New endpoint collection metadata is independent of historical
migration-slice annotations.
