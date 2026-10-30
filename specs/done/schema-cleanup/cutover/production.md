# schema-cleanup cutover — production

## Reset cutover

Example User declared production unused and explicitly authorized a full wipe on
2026-07-23. A backup-first reset replaced the planned per-table deletion and
migration sequence; deleting only `anchors`, `fileEvents`, and `officialHub`
would have left related rows orphaned.

- Pre-reset recovery export: Convex snapshot `1784822659416555079`, including
  file storage
- Recovery export SHA-256:
  `3ee33fa9561d2a06bc8bc795f0fcd64144b4648aee16d03f5c0692d91e81fc13`
- Recovery export:
  `https://dashboard.convex.dev/d/elated-hippopotamus-235/settings/snapshot-export`
- Reset: imported an empty valid snapshot with `--replace-all --yes` into the
  exact deployment `Example User-2dce6:duet-v2:prod`; all application rows were
  removed
- Backend deploy: current functions and schema passed Convex validation and
  deployed under the message `schema-cleanup production reset cutover`
- Starter drive: published last, after official-hub recovery, and download-hash
  verified as
  `66fd29bb1f0d8261de8f9cf98271fe5ffbce6152c5a365c2dcd4a2c5b5df23a1`

## Official-hub restoration

The first supported seed attempt exposed producer/consumer skew: the old API
omitted `apiScopes` from the seed manifest and the old VM image's gateway
omitted `apiScopes`/`appId` from reconciliation reports. The stricter final
backend contract stayed intact.

Latest staging supplied the promoted production boot image
`ghcr.io/aomni-com/duet-vm-image@sha256:26576e20d582737ac9469065e245ee25aba306a70b50c8582e94ce726155bfec`.
The exact pin was applied to Convex and the API project's production
configuration. Both app-free official workspaces were archived and
reprovisioned onto that image before the seed resumed. They registered active
with agent `0.3.2` and gateway `0.0.0+8ee9bd6d7345`.

The supported idempotent operator flow then completed:

- `user@example.invalid` owns the dedicated `official-agents-hub` workspace
- one `officialHub` singleton and one completed `officialHubSeedRuns` row exist
- the hub contains the three official agents and their three app rows
- one `official-agents` folder publish points at the hub
- `GET https://service.example.invalid/v1/official-agents` returns HTTP 200 with
  `data-analyst`, `research-assistant`, and `writing-editor`
- only after those checks passed, the starter-drive bundle was published

## Post-reset verification

- Final recovery export: Convex snapshot `1784826040271174739`, including file
  storage
- Final export SHA-256:
  `4caea6c6966f8c1b32baa3feccbe310d55d1e1faf4211d6f25a5f81104e3e574`
- Final export:
  `https://dashboard.convex.dev/d/elated-hippopotamus-235/settings/snapshot-export`
- All cleanup probes: CLEAN
- Unified `rateLimits`: no rows and no unclassified keys
- Legacy daily/monthly usage tables: absent from the final schema; zero retained
  history
- Dropped-field probes: no retained values for any removed field
- Starter-drive current hash:
  `66fd29bb1f0d8261de8f9cf98271fe5ffbce6152c5a365c2dcd4a2c5b5df23a1`

## Operational singleton restoration

The reset removed `vmUpdateControl`, whose intentional missing-row default is
paused. Once production was on the final schema and the official-hub
workspaces were restored, the supported operator script recreated exactly one
global row:

- `paused: false`
- reason: `schema-cleanup reset complete; resume production rollout`
- verified directly in `Example User-2dce6:duet-v2:prod`

The later staging fix `115b1984` changes the missing-row default to unpaused.
Production remains safe before that code is promoted because its explicit
enabled row is present.

## Pre-reset drift report

- Snapshot: 2026-07-23T12:12:13.254Z
- Operator: Codex
- Source: read-only Convex snapshot export (production); analyzed locally
- Export command: `bunx convex export --deployment Example User-2dce6:duet-v2:prod --path <temporary snapshot.zip>`
- Analyze command: `bun packages/backend/scripts/schema-cleanup-preflight.ts --snapshot <temporary snapshot.zip> --environment production --operator Codex`
- Row contents: intentionally omitted
- Deployment freeze: superseded by the explicitly authorized full reset above

## Verdicts

- Anchor settings slug drain: NEEDS-FIXUP (8 rows)
- Credit metadata held-reservation safety: CLEAN
- Gateway generation required field: CLEAN
- Daily/monthly usage history migration: CLEAN (no history)

## Anchors

- Rows with settings.slug by kind: agent=3, app=5
- App/agent anchors updated in the last 24h: 8
- Latest app/agent anchor update: 2026-07-22T18:21:02.553Z

## Credit transaction metadata

- Rows: 1
- Metadata keys: canonicalEmail=1, grant=1, source=1
- Metadata key types: canonicalEmail:string=1, grant:string=1, source:string=1
- Held reservations: 0
- Unclassified keys on held reservations: none

## Gateway generations

- Missing chargeToWorkspace by status: none

## Usage history

- creditDailyUsage: 0 rows
- monthlyUsage: 0 rows

## Rate-limit drain

- browserSessionMintRateLimits: 0 rows; 0 active; newest updatedAt none
- deviceRateLimits: 0 rows; 0 active; newest updatedAt none
- shareEmailRateLimits: 0 rows; 0 active; newest updatedAt none
- workspaceRateLimits: 0 rows; 0 active; newest updatedAt none

## Field-drop probes

- auditEvents provenance.sync: CLEAN
- billingTopups.stripePaymentIntentId: CLEAN
- fileAccess.userId: CLEAN
- fileEvents.userId: CLEAN
- fileEvents.size: NEEDS-FIXUP (18 rows)
- fileEvents.mtimeMs: NEEDS-FIXUP (18 rows)
- officialHub.seedVersion: NEEDS-FIXUP (1 rows)

## Onboarding-schema delta re-probe

- Snapshot: 2026-07-23T15:22:22.215Z
- `workspaces.duetName`: KEEP — written by onboarding and rendered as the Duet identity.
- `workspaces.onboardedAt`: KEEP — written by workspace birth/onboarding and read by the route gate.
- `workspaces.officialAgentsOnboardingPendingAt`: CLEAN; its writer and reader were removed by the replacement onboarding rail.
