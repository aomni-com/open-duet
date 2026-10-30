# schema-cleanup cutover — staging

## Completed reset cutover

Example User declared staging disposable on 2026-07-23 and chose a full database
reset instead of the planned per-row migrations and drain windows. This
removed the need for a deployment freeze or two-deploy writer-stop sequence in
this environment. Production was handled as a separate cutover recorded in
[`production.md`](production.md).

- Pre-reset recovery export: Convex snapshot `1784822048137644519`, including
  file storage
- Recovery export SHA-256:
  `96a814f3bdc951bb0180a464566a223fe017cc3c467427fdf546ea9b864ed580`
- Recovery export:
  `https://dashboard.convex.dev/d/chatty-llama-452/settings/snapshot-export`
- Reset: imported an empty valid snapshot with `--replace-all --yes` into the
  exact deployment `Example User-2dce6:duet-v2:staging`; all application rows were
  removed
- Backend deploy: current branch functions and schema became ready at
  2026-07-23T15:58:56Z; repository type checks were already green
- Post-deploy proof snapshot: 2026-07-23T15:59:06.258Z
- Starter drive: published and download-hash verified as
  `66fd29bb1f0d8261de8f9cf98271fe5ffbce6152c5a365c2dcd4a2c5b5df23a1`
- Final post-seed proof snapshot: 2026-07-23T16:02:52.446Z
- Final verdict: every anchor, generation, usage-history, rate-limit, and
  field-drop probe is `CLEAN`

The official-agent golden workspace is deliberately not pre-seeded here. Its
live internal-admin seed endpoint and idempotence are part of the staging e2e
contract, so that journey must create and verify it.

## Post-merge staging recuts

An automated staging deployment from the pre-cutover branch landed after the
reset above and resumed the legacy app-anchor writer. The next API rail rejected
the final schema because ten app anchors again carried `settings.slug`; the
rejection happened before the API preview or staging alias changed. The branch
still contained the intended one-owner schema, so this was environment drift,
not a schema merge regression.

- Pre-recut recovery export: Convex snapshot `1784827487679448082`, including
  file storage
- Pre-recut snapshot size: 747 MB
- Pre-recut SHA-256:
  `4375a4ebd20ad88c8b4619388861a1a149d60b63cc76a4a08ce827e5aff50a45`
- Drift probe: ten app anchors carried `settings.slug`; `creditDailyUsage` and
  `monthlyUsage` each had two rows; all other field-drop and required-field
  probes were clean
- Recut: imported the same reviewed empty snapshot with `--replace-all --yes`,
  then immediately pushed the final branch schema and functions directly to
  `Example User-2dce6:duet-v2:staging`
- Starter drive: republished and download-hash verified as
  `66fd29bb1f0d8261de8f9cf98271fe5ffbce6152c5a365c2dcd4a2c5b5df23a1`
  (`kg258pkd2ef332heahh941343d8b289m`)
- Post-recut proof export: Convex snapshot `1784827730424772079`
- Post-recut SHA-256:
  `f62d988eb4b8d0790adc6eb13dbb1be9066e382572ea785992fa90f5d9ea27f5`
- Post-recut verdict: every anchor, generation, usage-history, rate-limit, and
  field-drop probe is `CLEAN`

The API deployment rail then repeated the same Convex push successfully:
schema validation completed, the starter bundle was unchanged and verified,
and the API preview became ready before its canonical staging alias moved.

Two newer `origin/staging` commits then completed their already-queued automatic
API rails. The later rail again restored the pre-cleanup backend long enough to
write one `hello` app anchor with `settings.slug`. After merging through
`3e383f6b`, verifying no API build remained queued, and re-running the focused
latest-staging tests, the environment received one final backup-first recut:

- Final pre-recut recovery export: Convex snapshot `1784828514128946985`,
  including file storage
- Final pre-recut snapshot size: 747 MB
- Final pre-recut SHA-256:
  `21c87fe1bdd631eb3c234eae1f89d4ca5293ec5c756df7205ba09d34998eccda`
- Final drift probe: one app anchor carried `settings.slug`; usage history and
  every other cutover probe were clean
- Final reset: imported the reviewed empty snapshot with `--replace-all --yes`,
  directly pushed the final schema, and republished the starter drive as
  `66fd29bb1f0d8261de8f9cf98271fe5ffbce6152c5a365c2dcd4a2c5b5df23a1`
  (`kg247aqvh1n7x3jjbdq1tx2y518b3ef1`)
- Latest API rail: Convex schema validation completed, the starter drive was
  unchanged and verified, deployment `dpl_AagM2iJx5eSj2rKh8pgfBs7NYkib`
  became ready, and `service.example.invalid` moved only afterward
- Final proof export: Convex snapshot `1784828914024938645`
- Final proof SHA-256:
  `ccb3fe6152f7aac84132a189e94a88c1373cc176a0cf6121f00fb5ea620c86f2`
- Final proof verdict: every anchor, generation, usage-history, rate-limit, and
  field-drop probe is `CLEAN`
- Stability check: `origin/staging` remained at `3e383f6b`, the branch contained
  it, and Vercel reported no queued or building API deployments

## Live staging closeout

The complete live run
`staging-e2e-synthetic` passed every journey leg it reached before one
Drive transport assertion stopped the run. Google OAuth was intentionally
skipped because no dedicated staging identity was configured. Connected
providers, sharing, official agents, browser completion, route sweep, and
build-app occur after Drive and were therefore not exercised by this run.
Resource cleanup still deleted all 46 recorded resources and reported zero
orphans.

The remaining assertion distinguished two literal filenames. `100%` survived
the browser proxy, while a filename containing the literal text `a%2Fb`
returned 404 after the deployed Next.js catch-all path was decoded twice. The
web proxy now derives the raw request path itself, decodes each segment exactly
once, and re-encodes the segments at the API boundary.

- Fix commit: `0b236ec6`
- Tested staging composite: `f887d6e5`
- Web deployment: `dpl_A6t72kcSmUYY71B3GPLTRkHxicUH`
- API deployment: `dpl_EfkZGHF53RmW5bgNw4BvLtqBy8Dw`
- Staging alias: `https://service.example.invalid`
- Approved focused rerun:
  `staging-e2e-synthetic`
- Focused proof: first load and reload returned the exact contents for both
  `100%-y-2a445d.txt` and `a%2Fb-y-2a445d.txt`
- Focused cleanup: all four recorded resources deleted; zero orphans

The focused rerun exercises the exact browser → web proxy → API → VM seam that
failed in the complete run. It deliberately avoids repeating the stochastic
model-emitted-link prerequisite; the complete run had already passed that
broader Drive path before reaching the percent-identity assertion.

## Operational singleton restoration

The reset also removed `vmUpdateControl`. Its intentional missing-row default
is paused, so the first live closeout run could not converge a fresh VM to the
current gateway release. After the final staging API and VM release were ready,
the supported operator script recreated exactly one global row:

- `paused: false`
- reason: `schema-cleanup reset complete; resume staging rollout`
- verified directly in `Example User-2dce6:duet-v2:staging`

The subsequently merged staging fix `115b1984` also changes the missing-row
default to unpaused. The singleton is now an explicit emergency brake rather
than a prerequisite seed; the restored row remains as visible operator state.

## Pre-reset drift report

- Snapshot: 2026-07-23T12:11:58.674Z
- Operator: Codex
- Source: read-only Convex snapshot export (staging); analyzed locally
- Export command: `bunx convex export --deployment Example User-2dce6:duet-v2:staging --path <temporary snapshot.zip>`
- Analyze command: `bun packages/backend/scripts/schema-cleanup-preflight.ts --snapshot <temporary snapshot.zip> --environment staging --operator Codex`
- Row contents: intentionally omitted
- Deployment freeze: superseded by the approved full reset above

## Verdicts

- Anchor settings slug drain: NEEDS-FIXUP (1052 rows)
- Credit metadata held-reservation safety: CLEAN
- Gateway generation required field: NEEDS-FIXUP (872 rows)
- Daily/monthly usage history migration: NEEDS-MIGRATION (1378 rows)

## Anchors

- Rows with settings.slug by kind: agent=15, app=1037
- App/agent anchors updated in the last 24h: 18
- Latest app/agent anchor update: 2026-07-23T11:12:55.869Z

## Credit transaction metadata

- Rows: 4183
- Metadata keys: canonicalEmail=401, eventId=61, generationId=2421, grant=401, invoiceCreatedAt=682, modality=2421, model=2421, note=210, periodEnd=682, periodStart=682, plan=682, reason=112, source=462, totalCents=61, upstreamGenerationId=2421, upstreamMetadata=2421
- Metadata key types: canonicalEmail:string=401, eventId:string=61, generationId:string=2421, grant:string=401, invoiceCreatedAt:number=682, modality:string=2421, model:string=2421, note:string=210, periodEnd:number=682, periodStart:number=682, plan:string=682, reason:string=112, source:string=462, totalCents:number=61, upstreamGenerationId:string=2421, upstreamMetadata:object=2421
- Held reservations: 0
- Unclassified keys on held reservations: none

## Gateway generations

- Missing chargeToWorkspace by status: released=5, settled=867

## Usage history

- creditDailyUsage: 694 rows; 2026-07-10 through 2026-07-23
- monthlyUsage: 684 rows; 2026-07 through 2026-07

## Rate-limit drain

- browserSessionMintRateLimits: 5 rows; 0 active; newest updatedAt 2026-07-23T03:20:19.156Z
- deviceRateLimits: 2 rows; 0 active; newest updatedAt 2026-07-21T04:47:30.317Z
- shareEmailRateLimits: 56 rows; 0 active; newest updatedAt 2026-07-22T10:36:40.238Z
- workspaceRateLimits: 352 rows; 0 active; newest updatedAt 2026-07-23T11:00:29.605Z

## Field-drop probes

- auditEvents provenance.sync: CLEAN
- billingTopups.stripePaymentIntentId: CLEAN
- fileAccess.userId: CLEAN
- fileEvents.userId: CLEAN
- fileEvents.size: NEEDS-FIXUP (1381 rows)
- fileEvents.mtimeMs: NEEDS-FIXUP (1381 rows)
- officialHub.seedVersion: NEEDS-FIXUP (1 rows)

## Onboarding-schema delta re-probe

- Snapshot: 2026-07-23T15:22:40.833Z
- `workspaces.duetName`: KEEP — written by onboarding and rendered as the Duet identity.
- `workspaces.onboardedAt`: KEEP — written by workspace birth/onboarding and read by the route gate.
- `workspaces.officialAgentsOnboardingPendingAt`: NEEDS-FIXUP (2 rows); its writer and reader were removed by the replacement onboarding rail.
