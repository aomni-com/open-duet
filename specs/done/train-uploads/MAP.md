# Train Uploads — Quadrant Map

Walked 2026-07-15 with Example User. Status: **map complete; slice ladder written
(see `README.md`) — implementation starts there, not here.** This map is the
binding decision record the slices implement.

**The change:** train runs on the exact bytes the user uploads. The browser
stops doing `file.text()`; files stream raw into a singleton per-VM uploads
folder; URLs are Firecrawl-scraped to markdown at add-time; `duet train`
consumes the folder and the trainer does all extraction. Chat-app (v1) is the
precedent (`specs/done/agent-drive/research/chat-app-train-memory-system.md`).

---

## Q1 — Known knowns (settled ground)

- Today's flow corrupts binary at the first hop: `file.text()` in
  `apps/web/spa/routes/train.tsx:91`, `readFile(file, 'utf8')` in
  `packages/duetfs/src/train.ts:40`. Bytes then travel as JSON through
  api → Convex action → VM gateway → ephemeral `mkdtemp` staging →
  `duet train <dir>` (external pinned `@duetso/agent` binary,
  `packages/gateway/src/train/duet-cli-runner.ts`).
- The schema's `encoding: 'base64'` is dead code that would corrupt anyway:
  `decodeCorpusFile` does `.toString('utf8')` on decoded bytes
  (`packages/gateway/src/train/pipeline.ts:165-168`).
- v1 shipped the wanted behavior: client sent utf8-or-base64, allowlisted
  text/code/PDF/image/Office, trainer extracted. The trainer handles binary —
  at least at v1's `@duetso/agent@0.1.202`.
- A binary-faithful upload rail already exists (Files surface → raw PUT →
  atomic write into the VM drive, `packages/gateway/src/routes/files.ts:101-179`);
  its temp-write+fsync+rename pattern is the one to copy.
- Firecrawl is already integrated in-repo
  (`apps/lander/lib/server/growth-brief-core.ts`, `api.firecrawl.dev/v2/scrape`)
  with keys in `.env.staging`/`.env.production`.
- Resend transactional email rail exists with an idempotent delivery ledger
  (`packages/backend/convex/services/email.ts`).

## Q2 — Known unknowns (decision ledger)

| # | Question | Resolution | Closed by |
|---|----------|------------|-----------|
| 1 | Transport | Raw streamed PUTs into a **singleton per-VM uploads folder**; no uploadIds — filename is identity; `POST /train` takes no required body | Example User |
| 2 | Folder lifecycle | Cleared on **success only**; failed runs keep sources for retry; 409 on start while running; snapshot-move on start so mid-run uploads belong to the next train | Example User (settled-unless) |
| 3 | Redaction | **Dropped entirely** from the train pipeline (`redactText` out) | Example User |
| 4 | Types & caps | **Every file type accepted**; **1 GiB** total folder cap, single owner (gateway). Existing 200-file count cap kept unless it bites | Example User |
| 5 | CLI parity | `duetfs train --file` moves to the same raw-PUT seam | Example User (settled-unless) |
| 6 | Trainer handles binary on v2 VMs | **Out of scope** — delegated to a duet-agent session; disk headroom moot (prod VMs much larger). Not a build blocker | Example User (2026-07-15) |
| 7 | Vercel body limits | Resolved by landmine 1: uploads go **direct-to-VM**, Vercel leaves the byte path | Territory |
| 8 | Job orchestration for hour-long runs | **Gateway owns the job** (durable VM-side state, boot reconciliation); status rides the vm-sync-rail 5s poll into Convex | Example User |

## Q3 — Unknown knowns (extracted)

- **Firecrawl replaces the scraper** — `packages/gateway/src/train/url-scraper.ts`
  is deleted, not fixed. Scrape runs server-side in apps/api (where the key
  can live), result gets frontmatter and is PUT into the uploads folder.
- **`files`/`urls` stay in `TrainStartRequestSchema`** — corpus = uploads
  folder ∪ inline request sources. Keeps ad-hoc runs possible (agent trains
  on a drive file without the UI).
- **Consumers: all four** — web UI, duetfs CLI, MCP tool, agent-initiated.
  MCP/agent trigger against refs; they never carry bytes.
- **Completion: fire-and-forget + notify** — Resend email (new
  `train_complete` deliveryKind) and a UI toast on the done transition.
- **Scraped-URL artifact shape** (stolen from samples): frontmatter
  `url`/`title`/`scrapedAt`; filename = slugified URL so re-add overwrites;
  content-type gate comes free with Firecrawl.
- **List response powers resume**: `GET /uploads` returns
  `{files:[{filename,size,uploadedAt,url?}], totalBytes, capBytes, running}` —
  gateway parses frontmatter so the UI stays dumb; one call disambiguates
  resume-vs-training.
- **UI**: silent resume restore + "from last time" note; per-file progress
  with cancel; chips locked while running.
- Done-bar assumed (P2 unanswered): staging deploy + the slice-11 E2E runbook
  passing (trainer-quality probe was later cut from scope — ledger #6).

## Q4 — Unknown unknowns (landmines)

### Decided

1. **Vercel edge caps request bodies ~4.5 MB before function code runs** —
   `duplex:'half'` in `duet-proxy.ts:138-148` / `gateway/client.ts:240-252`
   is cosmetic; apps/web has no `maxDuration` at all; apps/api's 800s can't
   hold a slow 1 GiB stream. → **Uploads go browser/CLI → VM gateway
   directly** (`https://<vm>:3000/v1/train/uploads/:filename`) with a
   short-lived edge token minted by apps/api; gateway gains CORS.
   *Escalated latent bug, beyond this feature: the Files-surface upload rides
   the same Vercel path with no size guard — drive uploads >4.5 MB are
   silently broken in prod today.*
2. **Convex-action-holds-stream can't own hour-long jobs** — no watchdog, no
   reaper (rows stick at `running` forever), `duet train` child invisible to
   the orphan sweep (`orphan-sweep.ts:13-46`), self-update force-exits
   through active runs after the 24h defer deadline (`update-gate.ts:43-46`).
   → **Gateway owns the job**: persist job state on the VM, return 202,
   reconcile staging + orphaned children at boot, surface state via the
   vm-sync-rail poll; Convex fires email/toast off the state transition.

### Sharp edges (build checklist)

| # | Edge | Evidence | Consequence |
|---|------|----------|-------------|
| 1 | Bun default 128 MiB body cap | `runtime/http.ts:734-746` | Set `maxRequestBodySize` explicitly |
| 2 | No folder-quota mechanism exists | files PUTs are size-independent | Build 1 GiB accounting: sum folder before each PUT |
| 3 | `runDuetTrain`: no timeout, unbounded stdout buffer | `duet-cli-runner.ts:7-34,65-72` | Mirror `records.ts:139-165` (output cap + generous kill deadline) |
| 4 | Staging never swept at boot | `pipeline.ts` finally-blocks skip SIGKILL | Boot reconciliation (part of gateway-owns-job) |
| 5 | `sanitizeCorpusPath` is the weak sanitizer | `pipeline.ts:196-203` vs `normalizeDrivePath` + files.ts O_NOFOLLOW | New PUT uses the strong vocabulary, rejoined against uploads dir (not the hardcoded drive root) |
| 6 | `TRAIN_REQUEST_HEADERS = ['content-type']` | `gateway/client.ts:31` | Use files-grade allowlist where api still proxies train routes |
| 7 | `FIRECRAWL_API_KEY` topology-locked to lander, test-enforced | `secret-topology.mjs:17`, test :22-24 | Deliberately widen to `api` + provision Vercel env |
| 8 | Firecrawl call lacks local abort deadline | `growth-brief-core.ts:55-71` | Wrap in `AbortSignal.timeout` (pattern: `media.ts:206-215`) |
| 9 | `deliveryKind` union defined in 3 places | `schema.ts:238`, `services/email.ts:9`, `emailDeliveries/model.ts:5` | Add `train_complete` everywhere or consolidate to one owner |
| 10 | `trainJobs` has no creator identity | `schema.ts:727-754` | Add `userId` at creation — email needs an addressee |
| 11 | Cosmetic progress flatlines at 95% | `duet-cli-runner.ts:74-96` | Replace with honest coarse phases |
| 12 | `fetch` has no upload progress | no XHR in SPA | XHR `upload.onprogress` (or counting TransformStream) + AbortController |
| 13 | memory.db lock race widens to whole run | records CLI 5s lock wait vs hour-long trainer write; known 502 defect | **Resolved by slices 00a/00b** (see addendum): typed 503 `memory_lock_timeout` + calm banner with gentle poll |
| 14 | MCP bodies are JSON strings | `apps/mcp/src/server.ts:25` | MCP train tool triggers by ref only (by design) |
| 15 | No single-concurrent-job guard exists anywhere | fresh UUID per job; `activeTrainRuns` gates idle-shutdown only | 409 guard is new gateway logic |
| 16 | `idleTimeout: 255` is Bun's hard max | `runtime/http.ts:736-739` | A >255s client stall kills an upload; acceptable, document it |

### Confirm before coding — SUPERSEDED by the slice ladder

These confirms became slices when the plan materialized: browser→VM
reachability/CORS is slice 01 (kill probe); the vm-sync slot is slice 07's
`trainReports` design (with the acked outbox). Disk headroom and the trainer
probe were cut — delegated to a duet-agent session; prod VMs will be much
larger (Example User, 2026-07-15).

---

## Tweakable build plan — SUPERSEDED by the closed README

Kept for the record of what was proposed pre-slicing. The authoritative plan
is the ladder in `README.md`; where this section and a slice file disagree,
the slice file wins (e.g. the auth handshake is a dual-credential grant —
edge token + upload token — not the single token sketched below).

1. **Direct-upload auth handshake** — proposed: api endpoint returns
   `{vmBaseUrl, token, expiresAt}` per train session; browser/CLI PUT with
   bearer. Alternative: per-file tokens. Tweak here if the token TTL or CORS
   shape feels wrong.
2. **Job-state transport** — proposed: extend vm-sync-rail poll payload.
   Alternative: gateway callback POST to api on transitions. Pick when the
   rail's extension point is confirmed.
3. **Contract vocabulary home** — uploads list/response shapes, frontmatter
   keys, folder cap constant all live in `packages/contract/src/train/`.
4. **UI states** — staging / uploading (XHR progress + cancel) / silent
   resume / locked-while-running; budget meter from `totalBytes`/`capBytes`.
5. **Completion wiring** — `train_complete` email + toast off the Convex
   transition.
6. **Mechanical** (trusted): delete url-scraper + redaction; strong sanitizer;
   Bun body cap; folder quota; runner timeout/output cap; boot reconciliation;
   orphan marker; 409s; `userId` on trainJobs; secret-topology widening;
   duetfs rework; retire the triplicated 10 MiB measurement.

## Kickoff — DONE (2026-07-15)

write-spec already ran: three biased drafts were synthesized into the slice
ladder in `README.md`. **Implementation starts from the README's "Next Agent
Prompt", not from this map.** The map remains the binding decision record —
slices implement it, never reopen it.

---

## Addendum — records busy-state walk folded in (2026-07-15)

A second quadrant walk (the staging 502-during-training incident) was folded
into this spec as slices **00a/00b** per Example User — one training spec, not two.
The walk's full map and the user-approved banner mock live in this folder:
`visualizations/train-busy-map.html` (four quadrants, tweakable plan) and
`visualizations/train-busy-banner-mock.html` (the approved banner design —
00b implements THESE specimens, real app tokens, light+dark). Its ledger is
binding alongside this map's:

| # | Decision | Closed by |
|---|----------|-----------|
| A1 | Busy = one vocabulary: shared gateway classifier on `MEMORY_CLI_CONTRACT.exitCodes`; exit 75 → 503 `memory_lock_timeout` from memory AND train-records routes; `message` (stderr) kept in the body | Example User |
| A2 | UI: calm info banner, two copies (training copy when jobs show a live job, else "memory is busy"), stale list kept; destructive banner only for real failures | Example User (mock-approved) |
| A3 | Recovery: **gentle ~3s poll while busy** — Example User 2026-07-15: keep polling; most jobs < 2 min, users navigate away from longer ones (supersedes an interim no-poll-while-running amendment) | Example User |
| A4 | Lock budgets: trainer import 30s (`DEFAULT_TRAIN_IMPORT_LOCK_WAIT_MS`, contract-owned; slice 06 consumes); all request-shaped routes stay 5s. The 5s was an untuned placeholder from agent-drive slice 06 (`f063819`) | Example User |
| A5 | Delete `train_capability_unavailable` + `capabilityVersion` + `recordsUpgradeRequired` — backward compat the pin rail obsoletes; deploy-skew window accepted | Example User ("we don't do backward compat") |
| A6 | No gateway short-circuit on "is training"; the CLI attempt is ground truth (also: `activeTrainRuns` dies in this spec's slice 04/06 anyway) | Territory |
| A7 | Detail/edit/delete keep generic error copy; banner is list-card only | Decided + informed |

Sharp edge carried: the web poll must be a `refetchInterval` callback on the
settled error — `retry` would keep the query out of error state and the
banner would never render (pinned by a 00b test). OPEN (out of scope, owner
duet-agent): the agent's own in-VM memory writes block on the same lock
during a training.
