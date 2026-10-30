# Workspace archive storage — research report

Retrieved 2026-07-19 by a research agent from the cited primary sources. AWS
numbers from the official AWS Pricing API JSON for us-east-1 (publication
2026-07-14).

## 1. Candidates (per-GB-month, upload, restore, constraints)

| Provider / tier | Storage $/GB-mo | Upload (PUT/multipart) | Egress | Retrieval fee | Min duration | Notes |
|---|---|---|---|---|---|---|
| Cloudflare R2 Standard | $0.015 | $4.50/M Class A | Free | — | none | S3-compatible, presigned + multipart |
| Cloudflare R2 Infrequent Access | $0.010 | $9.00/M Class A | Free | $0.01/GB | 30 days | Same API, instant reads |
| AWS S3 Standard | $0.023 (first 50TB) | $0.005/1k PUT | $0.09/GB (first 10TB, 100GB/mo free) | — | none | |
| S3 Standard-IA | $0.0125 | $0.01/1k | $0.09/GB | $0.01/GB | 30 days | |
| S3 Glacier Instant Retrieval | $0.004 | $0.02/1k | $0.09/GB | $0.03/GB | 90 days | ms-latency reads |
| S3 Glacier Flexible | $0.0036 | $0.03/1k | $0.09/GB | $0.01/GB std (3–5h), bulk free (5–12h) | 90 days | Async restore step |
| S3 Glacier Deep Archive | $0.00099 | $0.05/1k | $0.09/GB | $0.02/GB std (~12h), $0.0025 bulk (~48h) | 180 days | Cheapest, slowest |
| Backblaze B2 | $0.00695 ($6.95/TB) | Free | Free up to 3x avg stored, then $0.01/GB | — | none | S3-compatible |
| Wasabi | $0.00799 ($7.99/TB) | Free | Free (fair use: egress ≤ stored volume/mo) | — | 90 days + 1TB monthly minimum | S3-compatible |
| Tigris Standard / IA / Archive-IR | $0.02 / $0.01 / $0.004 | $0.005/1k Class A | Free | free / $0.01/GB / $0.03/GB | none / 30d / 90d | S3-compatible |
| Vercel Blob | $0.023 | $5.00/M adv. ops (multipart = 1 op per part) | $0.05/GB + Fast Origin Transfer $0.06/GB on cache miss (blobs >512MB always miss) | — | none | 5TB max file; own SDK, not S3 |
| Hetzner Object Storage | ~$0.006 (base $5.99/mo incl. 1TB storage + 1TB egress; extra ≈ $5.95/TB-mo) | Free ops | $1.20/TB over included | — | none | S3-compatible; EU-only; 5GB single PUT, 10k-part multipart, 5TB max object |
| Hetzner Storage Box | ~$1–2/TB-mo (fixed slots) | — | Unlimited free | — | none | NOT S3 — SFTP/rsync/SMB only |

## 2. Cost at 500 archives × 75GB avg (37.5TB stored), 5%/mo restored (~1.9TB egress/mo)

| Candidate | Storage | Retrieval + egress | Total/mo |
|---|---|---|---|
| Hetzner Object Storage | ~$228 | ~$1 | ~$229 (EU-only) |
| S3 Deep Archive | $37 | $38 retr + $160 egress* | ~$235 (12–48h restore latency) |
| **Backblaze B2** | $261 | $0 (under 3x allowance) | **$261** |
| Wasabi | $300 | $0 | $300 |
| S3 Glacier Flexible | $135 | $19 + $160* | ~$314 (3–5h latency) |
| S3 Glacier Instant | $150 | $56 + $160* | ~$366 |
| R2 Infrequent Access | $375 | $19 | $394 |
| Tigris IA | $375 | $19 | $394 |
| R2 Standard | $563 | $0 | $563 |
| S3 Standard-IA | $469 | $19 + $160* | ~$648 |
| S3 Standard | $863 | $160* | ~$1,023 |
| Vercel Blob | $863 | ~$206 | ~$1,069 |

\* S3 internet egress $0.09/GB after 100GB/mo free. Request costs negligible
at this object count. At 25TB scale totals ×0.67; zstd compression (likely
2–3x on dev disks) scales everything down further.

## 3. Streaming ergonomics (near-full disk, no staging)

- Single presigned PUT is a non-starter: S3-compatibles cap single PUT at 5GB
  and curl needs Content-Length up front. Multipart is mandatory at 100GB.
- Every S3-compatible candidate supports streaming multipart from stdin, no
  disk staging:
  - `tar -C / -c . | zstd | rclone rcat remote:bucket/archives/<id>.tar.zst`
    (set `--s3-chunk-size 64M`; default 5MiB chunk × 10k parts caps ~48GB).
  - `aws s3 cp - s3://bucket/key` streams stdin; pass `--expected-size` for
    >50GB. `s5cmd pipe` and `mc pipe` likewise.
- Presigned-only multipart works but is chatty (control plane signs every
  UploadPart). Cleaner: mint short-lived prefix-scoped credentials — R2 has a
  temporary-access-credentials API; B2 application keys take `namePrefix` +
  validity — and let the VM run rclone/aws-cli directly.
- Restore: presigned GET has no size limit; `curl | zstd -d | tar -x`.
- Vercel Blob is the exception: own SDK/token flow, multipart billed per
  part, >512MB blobs never cache. Not fit for this.

## 4. Alternative: exe.dev native snapshots

No public exe.dev pricing — ask them for snapshot/copy storage $/GB-mo.
- Pro: zero byte movement, restore in minutes not a 100GB download,
  crash-consistent for fsynced writes, no tar plumbing.
- Con: fleet lock-in (relevant while exe.dev is itself under evaluation);
  snapshots usually bill full block size, not used/compressed bytes.
- Reference: block snapshots typically $0.03–0.05/GB-mo (EBS $0.05). Decision
  rule: exe quote < ~$0.01/GB-mo → snapshots win outright; $0.02–0.05 →
  3–7x B2, only sensible as a short warm-pause tier (snapshot 7–14 days for
  fast resume, then tar-to-object-storage and delete).

## 5. Recommendation

**Primary: Backblaze B2.** ~$261/mo at 37.5TB, free API calls, no minimum
duration, egress free to 3x stored (a 5% restore rate never approaches it),
instant reads. Integration: bucket `duet-archives`, keys
`archives/<workspaceId>/<archiveId>.tar.zst`; Convex action mints a
prefix-scoped ~2h key, gateway streams `tar|zstd|rclone rcat`, Convex writes
the metadata row; restore via presigned GET; GC cron + lifecycle rules
(always set abort-incomplete-multipart-after-7d — incomplete parts bill
everywhere).

**Runner-up: Cloudflare R2 Infrequent Access** (~$394/mo) if contractually
free unmetered egress and Cloudflare edge throughput are worth the delta.
Identical S3 SDK code, different endpoint.

Hetzner is cheapest but EU-only (cross-ocean 100GB transfers); Deep Archive
matches its price only with 12–48h restores — wrong for "I resubscribed,
bring my workspace back."

Sources: R2 https://developers.cloudflare.com/r2/pricing/ · S3
https://aws.amazon.com/s3/pricing/ (+ AWS Pricing API us-east-1) · B2
https://www.backblaze.com/cloud-storage/pricing · Wasabi
https://wasabi.com/pricing · Tigris https://www.tigrisdata.com/pricing/ ·
Vercel Blob https://vercel.com/docs/vercel-blob/usage-and-pricing · Hetzner
https://www.hetzner.com/storage/object-storage/
