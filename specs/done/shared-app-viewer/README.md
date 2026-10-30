# Shared app viewer & replica publishing — rationale record

**Status: shipped to staging 2026-07-22.** This spec was written *after* the code, from an
[`explore-unknowns`](../../../.agents/skills/explore-unknowns/SKILL.md) quadrant
walk over the diff — the walk exists because the work grew from a two-defect
bugfix into a feature (a new wire contract, a permission-model change, a UI
rework) without a spec up front. This document is the *why* and the
*invariants*; the code is the source of truth for *how*.

The full decision ledger — 17 closed decisions, who closed each, the landmine
cards, and the delta list — is the walk's map artifact. Everything below is the
durable subset of that map.

## E2E evidence at close (honest ledger)

The required `share-app-viewer` staging leg
(`proveSharedAppIsUsableAndPublishable`) ran live across several runs; staging
churned faster than any single full pass (each run imported newer unproven work
from parallel features), and Example User called the close on the accumulated
evidence:

- **Proven live** (runs on 2026-07-22): the recipient's replica arrives
  attached, private, `sourceShareMode: 'write'`, with `controls.makePublic`
  offered; the private replica's public URL refuses anonymous requests (403);
  the replica boots on its reassigned auto-port once the app honors `$PORT`.
- **Pinned by the Docker visual gate + unit suites**: the in-frame render and
  the UI publish → origin-stays-private → unpublish cycle. The one live
  attempt at this half failed only because the run raced the web deploy
  carrying the viewer; the leg stays required in `e2e:staging`, so every
  subsequent full run exercises it.
- The leg's first two live executions each caught a real defect elsewhere: a
  wrong presence assertion in the agent-lifecycle leg (runners legally park
  during long sleeps) and the `$PORT` replica landmine below.

## The two defects this fixes

1. **A private shared app 403'd when the recipient clicked it.** The Apps
   dashboard linked straight at the app's public URL
   (`{app}--{ws}.service.example.invalid`), which the edge refuses for a private app
   because there is no access grant. Only the Files view used the
   grant-minting `/launch` path. So public apps opened and private ones failed.
2. **Making a shared app public showed "The change could not be reconciled."**
   `setVisibility` threw `Replica apps are read-only` unconditionally, while the
   UI offered the "Make public" button because capabilities were derived from
   workspace role alone — and the recipient owns their own workspace. The button
   was advertised for a call the server always refused.

## What shipped

- **The Apps route is a viewer, not a dashboard.** Every path into an app —
  Files rows, phantom rows, the nav rail, a direct URL — lands on
  `/w/:ws/apps/:slug`, which renders the running app in an **iframe** fed by the
  grant-minting `/launch` redirect. This works identically for private and
  public apps: the redirect mints a short-lived access grant, the edge sets the
  session cookie, and the app renders for anyone who can already read the drive.
- **Visibility governs the public link, never usability.** The header shows the
  app name, its runtime state, `Publish` / `Make private`, and — only when
  public — `Copy public link` and `Open in new tab` (the clean `canonicalUrl`,
  which needs no grant). A private app is reachable only through the frame and
  advertises no URL.
- **A write-mode recipient can publish their own replica.** A replica is a real
  app on the recipient's own VM at the recipient's own URL, so sharing an app is
  sharing files: write access carries the right to publish that copy, and doing
  so never touches the origin app's visibility. Read-mode replicas can do
  neither and show a "Shared with you" chip instead of a control.
- **Per-app `controls` on the wire.** The app list's `capabilities` now answers
  only the workspace-wide question (`register`); what a caller may do to a
  *given* app (`updateRuntime` / `makePublic` / `makePrivate` / `delete`) is
  resolved per app and per share on the server, because role cannot answer it.
- **Every exit is an exit from something.** A replica leaves by dropping its
  share and a marketplace-managed app by uninstalling its subscription, which is
  why neither offers `delete`. A publisher dropping one app deletes that app's
  row; the remaining subscription still ships its siblings. `appIsInstalling`
  names the only managed switched-off state: the first pull has not landed yet,
  so visibility switches and direct deletion both stay unavailable.
- **The edge strips an app's frame-blocking headers.** A workspace app that
  sent `X-Frame-Options` or CSP `frame-ancestors` would refuse to render in the
  viewer; the edge drops both on app responses. They are header-only, so this
  is complete coverage.
- **Removing an app registration is "unlink," not file deletion.** The REST
  `DELETE /apps/:slug` removes the row and leaves the files. Deleting an app
  folder in Files deletes the bytes; filesystem reconciliation subsequently
  removes the stranded registration.

## Invariants (must stay true)

- **The app URL is never how a member reaches their own app.** In-product,
  every app opens through `/launch`, which mints a grant. The bare public URL is
  a sharing artifact, refused to anyone without a grant while the app is private.
- **A private app is usable; only its public link is withheld.** Framing works
  for private apps via the grant cookie; the public URL and open-in-new-tab are
  shown only when `visibility === 'public'`.
- **Publishing a replica publishes only the recipient's copy.** The origin
  app's `visibility` is the owner's alone; a recipient's publish moves only
  their own row and only while their share still grants write and the replica is
  not disabled.
- **What a caller may do to an app comes from the server, not from role.** The
  UI renders controls from the app's projected `controls`; it never re-derives
  permission from workspace role, so the "offered a button the server refuses"
  class of bug cannot recur.
- **A broken app offers no publish.** With no folder it can answer no URL, so
  `makePublic`/`makePrivate` are false and the viewer shows only repair.
- **"Publish" is one concept.** Publishing an app and publishing a folder both
  mean "make it available to the open internet; anyone with the link can view or
  use it." One verb, fewer concepts for the user.

## Landmine the e2e leg surfaced

**A replica of an app whose command hardcodes its port can never become
ready.** Replica seeding assigns a fresh port from the auto range
(41000–41999) and copies the command verbatim; the gateway health-checks the
assigned port while the app listens on its hardcoded one →
`reconcile_failed: did not become ready`. Apps must honor `$PORT` (the gateway
sets it; commands run under `bash -c`, so `$PORT` expands). The harness's own
fixture app violated this and was the first caught by the leg.

## Known limitations

- **The in-frame viewer of a *private* app does not work on `localhost`.** It is
  a cookie constraint, not a network one: on `localhost:3000` the app shell and
  the edge are cross-site, so the browser treats the frame as third-party and
  will not attach the `SameSite=Lax` grant cookie → a private app renders 403 in
  the frame. Public apps work; staging and prod work (they share `service.example.invalid`,
  making the frame same-site). The only fix — `SameSite=None; Secure` — weakens
  the grant cookie and needs HTTPS, so it is deliberately not done. Test
  private-app framing on a deployed preview, not localhost.

## Pointers into the code

- Web viewer: `apps/web/spa/apps/app-frame.tsx` (`appFrameSource` and the
  frame-source seam fixtures substitute) and `apps/web/spa/apps/app-actions.tsx`
  (the controls); status vocabulary lives in
  `apps/web/spa/status/entity-status.ts`, shared with agents. The header and the
  workspace-level page this spec built were later deleted — an app has one
  address, on its agent's card, and its controls hang off the chip that names
  it.
- Wire contract: `packages/contract/src/apps/index.ts` (`appControls`,
  `AppControlsSchema`, `sourceShareMode`).
- API projection: `apps/api/src/routes/apps.ts` (`appWire`, `appControlsSubject`).
- Replica policy: `packages/backend/convex/domains/apps/replication.ts`
  (`replicaSourceShareMode`, `requireWriteModeReplicaOriginApp`),
  `domains/apps/model.ts` (`setVisibility`).
- Edge frame-header strip: `apps/edge/src/index.ts` (`proxyToGateway`).
- E2E: `packages/test-harness/src/staging-e2e-synthetic`
  (`proveSharedAppIsUsableAndPublishable`, the required `share-app-viewer` leg).

## Cross-spec: `publish-viewer` co-occurrence audit

A single folder can be **both** an app root and a published folder at once. When
the [`publish-viewer`](../publish-viewer/README.md) UI surfaces a folder
"Publish" control on the same screen as this feature's app "Publish" button,
name them **"Publish app"** and **"Publish folder"** to disambiguate; while they
live on separate surfaces, plain "Publish" stands. This is a standing naming
rule for whichever feature first puts both buttons on one screen — at close, no
folder-publish button exists in the web UI.
