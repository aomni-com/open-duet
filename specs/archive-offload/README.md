# Archive Offload — trial-skip + object storage for 100GB drives

> **Superseded (2026-09-29):** [Workspace backup](../done/workspace-backup/README.md)
> is the active plan for the remaining object-storage work. It selects private
> Vercel Blob multipart uploads, one Drive-only ZIP producer, and replacement of
> existing lifecycle archive consumers. Its user-approved scope requires no old
> backup compatibility or migration framework. The provider choice, slice sketch,
> and pickup prompt below are historical context, not implementation instructions.

Status: **placeholder — trial skip shipped in per-tier-storage slice 07.**
Decisions D1–D2 are Example User's calls recorded 2026-07-19; the provider pick (D3)
is deliberately open. Pick the remaining provider work up when workspace
drives approach the current 1GB archive ceiling.

> **Superseded trial identity clause (2026-08-03):** trial decommission still
> uploads no archive bytes, but future never-subscribed workspaces remain the
> same `archived` identity and may recommission onto an empty VM after purchase.
> The shipped rationale is [trial workspace recommission](../done/trial-recommission/README.md).
> Subscriber object-storage work in this document remains unchanged.

## Why this spec exists

The pause→archive→resume rail stores a tar of the workspace drive in Convex
file storage (streamed via upload URL — see `archiveWorkspaceFromVm` in
`packages/backend/convex/domains/workspaces/provisioningActions.ts`). Convex
caps single files at 1GB and today's ~80MB archives already exposed the
runtime's buffering limits (fixed by streaming, fix36). Workspace disks are
headed to ~100GB, so the bytes must leave the Convex path entirely.

Full pricing/architecture research (2026-07-19, cited):
[assets/storage-research.md](assets/storage-research.md).

## Decisions

- **D1 — Trial workspaces are never archived.** A paused workspace whose owner
  never activated a subscription (`billing.subscriptionEverActivatedAt`
  undefined) skips the archive step at retire time: teardown the VM, drop the
  drive. We owe no data retention to trial users. This branch shipped in
  `specs/done/per-tier-storage/README.md`; the candidate query
  projects the policy before the action executes it. Note the interaction with
  D8/archive-resumable in specs/done/monthly-subscriptions: 7-day
  archive-resumable is a *subscriber* promise; trial pause becomes
  pause→retire with no resume-from-archive.
- **D2 — Subscribers' archives move to S3-compatible object storage**, bytes
  streamed **directly from the VM's gateway to the bucket** (scoped short-lived
  credentials or presigned multipart), Convex keeps only the metadata row
  (key, bytes, checksum, expiry). Convex file storage exits the byte path.
- **D3 — Provider: OPEN, Example User decides.** Research recommendation: primary
  **Backblaze B2** (~$261/mo at 37.5TB, free egress to 3× stored, no minimum
  duration, instant reads); runner-up **Cloudflare R2 Infrequent Access**
  (~$394/mo, contractually free egress, scoped temp-credentials API). Same S3
  SDK integration either way — the choice is a config/endpoint decision, not
  an architecture one. Also worth one email: ask exe.dev for snapshot storage
  pricing — below ~$0.01/GB-mo, provider-native snapshots beat object storage
  outright for warm pauses (zero byte movement, minutes-fast resume) at the
  cost of fleet lock-in.

## Slice sketch (to be firmed when picked up)

- `01-provider-and-bucket` — Example User picks D3; provision bucket + lifecycle
  rules (abort-incomplete-multipart-after-7d, expiry backstop) via an
  idempotent script in the provisioner mold.
- `02-gateway-streaming-upload` — Convex action mints scoped credentials /
  presigned multipart; gateway streams `tar | zstd` up with no disk staging
  (disk may be nearly full); reports size+checksum; Convex writes metadata.
- `03-restore-path` — presigned GET; fresh VM streams `curl | zstd -d | tar -x`
  through the existing pending-restore rail.
- `04-gc` — cron deletes expired archives (object + row) with per-item
  isolation (code-review rule 24); bucket lifecycle as backstop.
- `05-migrate-existing` — move/expire the Convex-stored archives; delete the
  Convex-storage path.

## Next Agent Prompt

Follow [Workspace backup](../done/workspace-backup/README.md) instead. The following
paragraph is superseded and must not reopen the settled provider/migration choices.

You are picking up the remaining object-storage placeholder; trial skip is
already built by per-tier-storage slice 07. First: confirm D3 with
Example User (B2 vs R2-IA vs exe snapshot quote). Then firm the slice files
(write-spec discipline — the sketch above has not been through a fog audit)
and start at `01-provider-and-bucket`. The archive rail you
are changing is live and e2e-covered (staging lifecycle leg 11 archives and
restores a real workspace); keep that leg green. Update this section before
ending your pass.
