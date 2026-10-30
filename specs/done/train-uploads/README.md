# Train Uploads — closed record (shipped 2026-07-16)

Train runs on the exact bytes the user uploads. Files stream raw from the
browser or CLI straight to the workspace VM's gateway into the selected root
or agent upload inbox; URLs are Firecrawl-scraped server-side into frontmattered
markdown; the external `duet train` binary consumes an immutable snapshot of
the inbox and does all extraction. The gateway durably owns every running job;
Convex
`trainJobs` is a projection fed only by the vm-sync rail; completion sends
exactly one Resend email and one UI toast. Shipped as PR #6 plus the
deploy-rail follow-up (PR #7); staging E2E evidence in
`assets/staging-e2e-synthetic/`.

[`MAP.md`](MAP.md) is the binding decision record this build implemented — the
quadrant walk, the eight-question ledger, and the records-busy addendum. Read
it for the original constraints; this README records what shipped and where
the build diverged.

## Why this shape

- **Bytes never cross Vercel, Convex args, or MCP JSON.** Vercel's edge caps
  request bodies (~4.5 MB) before function code runs, and hour-long jobs can't
  live inside a Convex action (no reaper; force-updates kill children). Those
  two landmines forced the whole architecture: direct-to-VM byte transport and
  a gateway-owned durable job.
- **Each scoped inbox is its corpus.** No upload IDs — filename is identity;
  re-PUT overwrites. Starting a root or agent job snapshot-moves only that
  scope's inbox; later uploads land in its recreated inbox and belong to the
  next run in that scope.
- **One job-ledger truth.** The gateway job controller owns every job's state
  machine, crash-durable ledger (temp → fsync → rename → dir fsync), job-scoped
  failed-run retention, boot reconciliation, and monotonic report outbox acked
  by the sync rail. Root and agent jobs may run concurrently.
- **Status rides the existing 5s sync rail** — no second timer, no callback
  channel. Convex ingestion is generation-idempotent and outside the ≤1/min
  observation throttle; a generation is acked only after its mutation
  persisted. First durable `done` schedules the email
  (`train_complete:<jobId>` idempotency key; `deliveryKind` has one owning
  list in `packages/backend/convex/deliveryKinds.ts`).

## The big divergence: public VM proxies, no edge credential

The plan assumed browser uploads would carry TWO credentials (exe.dev edge
token + gateway upload token). The slice-01 probe
(`research/edge-cors-probe-2026-07-15.json`) killed that: the exe.dev edge
307-redirects credential-less requests to its login page, and CORS preflights
can never carry credentials, so no browser can traverse a private proxy.
Resolution (Example User): workspace VMs are **`share set-public` at provision**
(`vmAttach.ts` — also re-asserted on the crash-retry re-record path), the
browser uses the portless `https://<vm>.service.example.invalid` URL, and the gateway's
default-deny bearer auth is the entire boundary — pinned by the route-spec
snapshot in `gateway.test.ts`. Upload tokens are path-scoped to
`/v1/train/uploads*`, 15-minute TTL, stored only as SHA-256 hashes with
timing-safe comparison (`packages/gateway/src/auth/upload-token.ts`).

That verdict made the whole exe.dev edge-credential rail dead weight — the
gateway never validated the header; it was pure ingress. A post-planning slice
deleted it end to end (−675 lines): token cache/mint in the api client, the
30-day rotation cron + schema fields, the publish-serving and sync-tunnel
token threads, every `:3000` port pin (all VM traffic is portless now). The
one non-mechanical piece: the tunnel resolve branch
(`domains/edge/model.ts:resolvePublicOrigin`) had the edge token as its ONLY
VM credential and first had to gain a real `deriveVmToken` bearer like the
apps/publishes branches already had.

## Principles & invariants (what must stay true)

- Inbox, temp dirs, and job snapshots live under `stateDir/train/` on one
  filesystem (rename atomicity), OUTSIDE the drive, and EXCLUDED from
  workspace archives — the archive tars stateDir buffered in memory and a
  1 GiB corpus would OOM the 2 GB VM (`vm/archive.ts` + pinning test).
- Quota is reservation-based, not sum-then-write: two concurrent near-cap
  PUTs must never both commit; `Content-Length` is a hint
  (`train/uploads-store.ts`).
- Job transitions ride an acked outbox, and the ledger tracks every active job
  independently — reporting only one current job loses terminal transitions
  when another job starts fast.
- Contract vocabulary has one owner (`packages/contract/src/train/uploads.ts`):
  caps, filename sanitizer (built on the strong drive grammar, never the old
  weak one), frontmatter/URL-slug, wire shapes. Contract modules stay loadable
  in the Convex isolate — no `node:` imports (`atob` is the one base64).
- The observational memory database route may still report
  `memory_lock_timeout`. Train records are ordinary memory files and have no
  database-lock or busy-banner state; the successor contract lives in
  [`specs/done/train-files/README.md`](../train-files/README.md).
- Inline `files` keep a 10 MiB ceiling (`MAX_TRAIN_INLINE_BYTES`) — they
  traverse JSON; never present 1 GiB parity. MCP's `train_start` structurally
  rejects byte fields.
- A 400/failed start must never leave a permanently-running job; success
  deletes only its own snapshot; failures retain theirs job-scoped for retry.

## Pointers

Gateway: `train/uploads-store.ts`, `train/job-ledger.ts`,
`train/duet-cli-runner.ts` (12 MiB output cap, 6h deadline), `train-runner.ts`
(202 start), `auth/upload-{token,scope,cors}.ts`, `vm/sync-client.ts`
(reports+acks). API: `routes/train.ts` (session broker, add-URL, start
dispatch), `src/train/scraper.ts` (Firecrawl, deliberately non-DRY with the
lander's — separate deploys), `routes/vm.ts` (sync ingestion). Backend:
`domains/train/model.ts:reconcileFromVm`, `deliveryKinds.ts`. Web:
`spa/api/train-uploads.ts` (XHR client, grant renewal),
`spa/routes/train.tsx`. CLI/MCP: `duetfs/src/train.ts` (streamed PUTs),
`apps/mcp/src/tools/train.ts`. Visual baselines live under the web visual-test
screenshots.

## Dead ends & discoveries

- **Gateway prepare/lease protocol for ad-hoc URLs** — drafted, rejected:
  three-call protocol to save a rare re-scrape. URLs resolve api-side into
  inline files in the start body; scrape-into-inbox was forbidden because a
  failed start would pollute the next run's corpus.
- **Per-file upload tokens** — rejected for chattiness; session grant with
  renew-before-PUT shipped.
- **Reattaching to a surviving trainer child at boot** — rejected: the
  NDJSON-less runner gives no re-attach channel; kill-and-fail is truthful
  and cheap to retry.
- **Convergence paths for existing fleet/data** — rejected on principle (no
  backward compat): the staging fleet was deleted and recreated public;
  stale Convex rows were stripped rather than migrated.
- **App-wide latent bug found (unfixed here):** `apps/web/app/layout.tsx`
  registers the sans variable font without a `weight` range, so the emitted
  `@font-face` has no weight descriptor and Chromium renders ONE weight
  app-wide — `strong`/`font-semibold` differ only by size/color. Fixing it
  (`weight: '100 900'`) re-renders every web baseline; needs its own visual
  sweep.
- **Escalated latent bug (pre-existing, unfixed here):** drive/files-surface
  uploads >4.5 MB ride Vercel and are silently broken; this feature's
  direct-upload seam is the likely future fix.
- **Deploy discoveries** (cost two failed E2E runs): `convex codegen` against
  a dev-type deployment *appears* to push functions but a schema-validation
  failure aborts the push silently — verify with `convex function-spec`. Old
  deployed crons keep re-writing old-shape rows while you clean data for a
  schema cutover; delete blocking rows through a deployed mutation immediately
  before deploying. This run motivated the deploy rail
  (`scripts/vercel-deploy-rail.mjs`): the api's Vercel build now runs secrets
  fanout + Convex deploy so the backend can never drift from the apps again.

## E2E evidence

`assets/staging-e2e-synthetic/` — the passing full staging run (train,
durability, publish, browser, admin legs; google-oauth skipped by env gate)
against freshly-provisioned born-public VMs. Not live-exercised: a >100 MB
browser upload (XHR progress/cancel pinned by component tests; the 1 GiB
reservation quota by store tests; edge traversal by the CORS probe) and the
200-file-cap unless-clause (MAP ledger #4 — revisit only if it bites).
