# Retrain memories — decision ledger

The quadrant walk that produced this, 2026-08-17. Every row below is a
**given**: settled with Example User during the walk, never re-opened during
implementation. Published map artifact:
<https://claude.ai/code/artifact/3a9aa521-0d64-4a81-8a8a-73877ff4a5cc>

## What the work is

Four strands of one body of work on the Train surface:

1. Training synthesis runs on the memory model, not a tier. **Shipped.**
2. Memory content is markdown, and renders as markdown.
3. A memory shows what it was trained from.
4. That memory can be retrained from those same sources, updating itself
   rather than spawning a new one.

## Already shipped before the spec existed

| Commit | What |
| --- | --- |
| `7c25d640a` | Training stopped claiming the `frontier` tier — a free workspace's synthesis calls were being refused one by one, and the CLI blamed the model for being "too small". |
| `4ff39855d` | Pinned to `gpt-5.6-luna` (`TRAIN_SYNTHESIS_MODEL`). |

Free-tier training works on staging today. Everything else here is unbuilt.

## The ledger

| # | Question | Decision | Closed by |
| --- | --- | --- | --- |
| 1 | Synthesis model | `gpt-5.6-luna` for every tier, billed at real model cost. It *is* the memory model and training is a memory operation; a concrete pin sends no tier header, so there is no ladder rate and no subscription gate. | Example User |
| 2 | Retrain mechanics | Clear the scope inbox, re-stage the archive, navigate to `/train/<scope>?retrain=<slug>`, POST carries `targetSlug`. **No confirmation** — staged files are always temporary. | Example User |
| 3 | Record identity | Keep the original slug; the displayed date moves. It is the identity the URL, the memory file, and the archive lifecycle all key on. | Example User |
| 4 | Sources on the page | Manifest list + frontmatter sniff, **with file sizes**. Sources are **clickable**: preview inline for text-like types, download for the rest. | Example User |
| 5 | Placement | **D2** — source strip directly under the title metadata, above the content. Retrain in the sticky top bar beside Edit. | Example User |
| 6 | Markdown depth | Full markdown in memory content. Each stored memory wrapped in **its own XML element** in `renderContextPack` instead of `\n\n`-joined. **Stored layer only** — global/local observations are the observer's one-liners and stay as they are. | Example User |
| 7 | URL sources on retrain | **Re-scrape** through the existing add-a-URL path; **fall back to the archived copy** when the scrape fails (404, moved, blocked). Files replay from the archive. | Example User |
| 8 | Archive retention | No cap, no expiry. Reclaim by deleting the memory. | Example User |
| 9 | Cross-member retrain | No author field, no gating, no confirm. Any member who can read the memory can retrain it. | `SECURITY.md` — one trust domain inside a workspace |
| 10 | `?retrain=` lifecycle | Persistent banner naming the target with a Cancel that drops the param; the param clears when the job reaches `done`. | Example User |
| 11 | No-archive wording | "The original sources are no longer available. This memory can still be read and edited, but it can't be retrained — training keeps a copy of what it read, and this one's copy is gone." | Example User |
| 12 | Notes mislabelled as pruned trainings | **Accept it.** A store-written note shows the #11 sentence and a disabled Retrain. The API's own add route writes to the DB, so only an in-workspace agent writing to the file store reaches this. Revisit by putting `kind` on the wire if it shows up in practice. | Example User |
| 13 | Scope travels with the target | Retrain navigates to the memory's own scope, and the server **rejects a `targetSlug` that doesn't resolve in the resolved scope** — otherwise a cross-scope retrain quietly creates a new memory in the wrong store. Same check refuses an inherited slug. | Example User (unopposed) |
| 14 | Retrain vs manual edits | No dialog. The banner says **replace**, not update, and lets the word do the warning. | Example User (unopposed) |
| 15 | Retrain while a job runs | Disabled from the running state the page already knows, rather than letting the user meet a raw `409 train_running`. | Example User (unopposed) |
| 16 | Where sources project | **Detail read only, never the list.** The frontmatter sniff is a file read per archived `.md`; doing it while listing multiplies by every memory in the store on every render. | Implementer (perf) |

## Provisional — implementer's call, reversible

Example User was offered these and did not rule; taken on the evidence so the run
never idles (see `implement-spec`'s never-block rule).

| # | Question | Provisional call | What would change it |
| --- | --- | --- | --- |
| P1 | Chips before "+N more" on the source strip | **8** | Any number Example User prefers; it is one constant. |
| P2 | Preview vs download | Preview inline for `.md`/`.txt`/`.json`/`.csv`, download for everything else | "Download for everything" halves the UI work and loses glancing at a scraped page. |

## Settled ground the build starts from

Facts verified during the walk; cited so nothing is re-derived.

- **Archives already exist and are already tracked.** Training writes
  `~/.duet/train/<memoryId>/` with `manifest.json` plus verbatim copies under
  `files/`. `archiveId`, `hasArchive`, `fileCount`, `sourceFolder` are already
  on the wire — the grey-out condition ships today.
  `duet-agent/src/train/archive.ts:31-43`, `src/train/types.ts:59-72`,
  `contract/src/train/index.ts:284-297`, `gateway/src/train/memory-store.ts:189-200`.
- **URLs survive into the archive** in YAML frontmatter (`url`, `title`,
  `scrapedAt`), and the inbox already recovers URL entries by reading exactly
  that. No manifest change needed.
  `contract/src/train/index.ts:148-184`, `gateway/src/train/uploads-store.ts:363,452-461`.
- **Retraining into an existing memory is half-built.** The pipeline installs
  output by `recordSlug` and deletes the prior archive when the id changes;
  only choosing that slug is missing.
  `gateway/src/train/pipeline.ts:114-141`, `job-ledger.ts:108,391-403`.
- **Training starts with an empty body and Retry is the same button**
  (`api.startTraining(workspaceSlug, {}, scope)`), which is why the retrain
  target must live outside the click.
  `apps/web/spa/routes/train/train-surface.tsx:164,838`.
- **The memory page renders no markdown**, splitting on blank lines into
  `<p class="whitespace-pre-wrap">`. A shared react-markdown component already
  exists and is used by sessions, files preview, and marketplace.
  `train-record-detail.tsx:249-253`, `packages/ui/src/components/common/markdown.tsx`.
- **Nothing serves archive contents.** No gateway route reads
  `~/.duet/train/*/files/`.
- **Filenames can't collide.** `urlToUploadFilename` is a pure function of the
  URL including an fnv1a32 hash, so a re-scraped URL lands on exactly its
  archived copy's filename and the fallback overwrites cleanly.
  `contract/src/train/index.ts:186-196`.
- **Markdown rendering is safe by default.** react-markdown v9 with no
  `rehype-raw`; raw HTML is escaped and URL sanitization is on. This mattered
  to verify because trained content derives from scraped pages.

## Sharp edges carried into the build

- **The 15,000-token pinned-store ceiling** is shared by all file memories in
  scope; on overflow whole entries leave oldest-first and a lone oversized
  entry is tail-truncated. Markdown scaffolding spends tokens against it.
  `duet-agent/src/memory/store/pack.ts:6,47-62`.
- **"Re-run with `--model <stronger model>`"** is now permanently wrong advice
  — the model is pinned and there is no stronger one. Rides along with the
  agent release. `duet-agent/src/cli/train.ts:182`.
- **Job history still prints raw stderr**, including a home path. Out of
  scope, unfixed, still ugly.

## Confirm before coding

- The gateway's `stateDir` in a live VM really is `/home/synthetic-user/.duet`, so
  `archiveId` resolves to the root the agent wrote to.
- Re-scraping up to 25 URLs on one re-stage stays inside the Firecrawl
  timeouts the train route already sets.
- Publishing duet-agent requires Example User. Closed: released as 0.3.12 and pinned.
  A VM must still take the new version before the markdown and delimiter
  changes are real for a given workspace.
- An archived source can be up to the 1 GB inbox cap, so the byte route needs
  a preview ceiling even though download is unbounded.
