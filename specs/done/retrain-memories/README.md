# Retrain memories

A trained memory renders as the markdown document it is, lists the sources it
was trained from, and can be retrained from those same sources — replacing
itself rather than spawning a second memory beside it.

Shipped 2026-08-17. The decision ledger from the quadrant walk that produced
this is [`MAP.md`](MAP.md); the decisions made where that ledger was silent are
[`choices.md`](choices.md).

## What shipped

Four strands of one change:

1. **Training synthesizes on the memory model.** `TRAIN_SYNTHESIS_MODEL` in
   `packages/contract/src/train/index.ts` pins `gpt-5.6-luna`.
2. **Memories are markdown**, written as markdown by the synthesis prompt and
   rendered as markdown on the page.
3. **A memory shows what it was trained from**, with scraped pages identified
   by URL and every source readable.
4. **Retrain** reloads those sources into the staging inbox and installs the
   next training over the same record.

Two of those live in a separate repo (`duet-agent`), shipped in 0.3.12, and
reach a given workspace when its VM takes that version.

## Why it works this way

### Training runs on a pinned model, not a tier

Left unpinned, the agent falls back to its own default *tier*, `frontier`,
whose models are all `paidOnly`. A free workspace's synthesis calls were
refused one by one and the CLI blamed the model for being too small — the
original bug report. Pinning a concrete model also removes the tier concept
entirely: no `x-duet-tier` header, so the gateway attributes the call as
internal and settlement bills the real model cost rather than a ladder rate,
and training never meets the subscription gate. That is the intent, not a side
effect (`packages/backend/convex/domains/modelGateway/settlement.ts`).

### The archive was already there; only a way to reach it was missing

`duet-agent` has always written `~/.duet/train/<memoryId>/` — a manifest plus
verbatim copies of the corpus — and the gateway already opened that manifest to
compute `hasArchive`. So "show the sources" is a projection of a file that was
being read and discarded, and "retrain" is a slug the pipeline was already
capable of installing over. The feature is mostly plumbing to something that
existed.

The one genuinely absent thing was a way to *read* archived bytes; that is the
only new I/O surface.

### Scraped pages identify themselves

A scrape is stored as markdown with `url`, `title`, and `scrapedAt` in YAML
frontmatter (`serializeScrapedUrlFrontmatter`). Because the archive copies
files byte-for-byte, an archived scrape still knows where it came from — which
is why the manifest never needed a URL field, why the source list can show
`titan.dev/pricing` instead of `url-titan-dev-pricing-a1b2c3d4.md`, and why a
restage puts URL entries back as URLs.

### Retrain re-scrapes rather than replaying

The reason to retrain a scraped page is almost always that the page changed, so
replaying a months-old snapshot would produce the same stale memory with
nothing saying so. Re-scraping is also *less* code than replaying: it reuses
the add-a-URL path, and `urlToUploadFilename` is a pure function of the URL, so
a successful re-scrape lands on exactly the archived copy it replaces.

Failure is never fatal. The gateway stages the whole archive first and the API
only overwrites what it can re-fetch, so a 404, a Firecrawl outage, and a
missing credential all leave a complete, retrainable corpus — the URL is named
in `fellBack` instead.

### The retrain target lives in the URL

The Train page has one button, relabeled "Retry training" after a failure
(`train-surface.tsx`). A target held in click-scoped state would vanish exactly
when the user retries. The URL keeps it — and because a URL also survives
*success*, a persistent banner names the target for as long as the parameter is
set and completion clears it. Without that, returning to a bookmarked link
weeks later would silently overwrite a memory.

## Invariants

These are the rules the implementation must keep honoring.

**Sources project on the single-record read, never the list.** Resolving a
scrape means opening the archived copy; on the record list that multiplies by
every memory in the store, on every render. `TrainRecordSummary` has no
`sources` field, and `listMemoryRecords` must never gain the frontmatter sniff.
Pinned by *"projects archived sources onto the record"* in
`packages/gateway/src/train/memory-store.test.ts`.

**A retrain target must resolve in its own scope.** Tolerating a cross-scope
`targetSlug` installs a *new* memory in the wrong store while the user's
original sits untouched — they are told their memory was replaced and it was
not. Removing that check turns the refusal into `202 Accepted`, which is what
*"refuses a retrain target that lives in another scope"* in
`packages/gateway/src/train/agent-routes.test.ts` pins.

**Every miss on the archived-source route answers 404 identically** — absent
file, traversal, symlink escape, no archive. Distinguishing them would answer
"what exists outside the archive?" for anyone who asked. Confinement compares
`realpath` of both ends, because a symlink planted under `files/` passes a
lexical prefix check.

**Restage refuses while a job is running for that scope.** It clears an inbox a
live job is reading. Validation of the incoming set happens *before* the
delete, so a refusal leaves the existing inbox intact.

**Only the observation layers are optimized.**
`optimizeObservationsForContext` strips bracketed text, collapses spaces, and
deletes `->` — correct for the observer's telemetry, destructive to an authored
document. The stored layer renders byte-for-byte
(`duet-agent/src/memory/observational.ts`).

**Gateway wire fields are optional forever.** VM gateways upgrade on their own
cadence, so `TrainRecord.sources` can be absent and the page must render
without it.

## Where the build diverged from the plan

**The seam is four routes, not two.** The contract's endpoint parity test
requires an agent-scoped twin for every root `train.*` endpoint. That is right —
an agent's memories live in the agent's own scope — but the plan described half
the surface.

**The synthesis prompt could not ship alone.** Instructing the model to write
markdown while `optimizeObservationsForContext` mangled markdown would have
shipped mangled markdown, so scoping that optimizer became part of the same
change. It is a pre-existing defect: every trained memory has been reaching
models with its links flattened and its arrows deleted.

**The API rebuilds the start body, so a new contract field is not enough.**
`apps/api/src/routes/train.ts` constructs the proxied body from scratch —
`urls` are scraped at the API and arrive at the gateway as `files` — so every
field the contract gains must be added there too. Nothing refuses a field left
out; it simply stops existing. This shipped broken and was caught only by the
live journey.

**The paragraph renderer needed overriding, and only a screenshot found it.**
Synthesis hard-wraps prose at around eighty columns; the shared `Markdown`
component preserves newlines so a chat message shows what someone typed. Every
memory paragraph broke mid-sentence. Unit tests asserting DOM elements passed
the whole time — see `MEMORY_MARKDOWN_COMPONENTS` in `train-record-detail.tsx`.

**A staging journey had to be created, not extended.** Train's live coverage
was a leg of the ~60-minute full run, so the feature could not be verified
without paying for all of it. `retrain-memory` in
`packages/test-harness/src/staging-e2e-synthetic` is standalone.

## Dead ends

**A dedicated `train-memory` visual fixture.** Written, then deleted:
`spa-shell` already owns a `train-memory-detail` scenario with read and edit
steps, and two fixtures for one page is sediment. The existing scenario's
record was enriched with markdown, sources, and a model instead — which is why
its baselines moved in this change.

**Strengthening `observation-groups.ts`'s `escapeAttribute` for reuse.** It
escapes only `"` and round-trips through a parser that never unescapes, so
widening it would turn a `&` in a cwd into a literal `&amp;`. The prompt
rendering is one-way and got its own complete escaper.

**Reusing `encodeDrivePathForGateway` for archived paths.** It runs
`normalizeDrivePath` first, which applies drive semantics an archive relPath
does not have. Only the encoding half was extracted, as `encodePathSegments`.

## Pointers into the code

| Surface | Where |
| --- | --- |
| Contract seams (`sources`, `targetSlug`, restage) | `packages/contract/src/train/index.ts` |
| Source projection + archive reads | `packages/gateway/src/train/memory-store.ts` |
| Shared frontmatter reader | `packages/gateway/src/train/scrape-frontmatter.ts` |
| Routes: sources, restage, retrain refusal | `packages/gateway/src/train-runner.ts` |
| Inbox replacement | `restage` in `packages/gateway/src/train/uploads-store.ts` |
| Re-scrape with fallback | `rescrapeStagedUrl` in `apps/api/src/routes/train.ts` |
| Page: markdown, source strip, Retrain | `apps/web/spa/routes/train/train-record-detail.tsx` |
| Banner + target plumbing | `train-surface.tsx`, `train-routes.ts` |
| Synthesis prompt, `<memory>` element | `duet-agent/src/cli/train.ts`, `src/memory/observational.ts` |
| Live journey | `packages/test-harness/src/staging-e2e-synthetic` |

## Visual provenance

No baseline or inspiration imagery drove this work — the standard was the
product's own existing chrome, and the reference was the live page in the
original bug report. The committed baselines under
`apps/web/tests/visual/__screenshots__/*/playground.spec.ts/train-memory-detail*.png`
are the record of what shipped, at both viewports.

The one visual requirement that came from outside the code was the placement
choice, made against three rendered options during the walk: sources sit
directly under the title metadata and above the content, so a reader sees what
the memory read before reading what it concluded. `MAP.md` row 5 records it.

## The agent release

The markdown prompt, the per-memory `<memory>` element, and the optimizer
scoping shipped in `@duetso/agent` **0.3.12** (`8408746`, released as
`72f59dc`); the catalog pin follows it. Memories are synthesized as markdown
and reach models with their links and arrows intact from the first VM that
takes the new version.

## The live run

`bun run e2e:staging -- --journey retrain-memory` passes against staging.
Evidence from run `staging-e2e-synthetic`: one record
after retraining (`recordCountAfterRetrain: 1`), keeping the slug it was
trained under, from two distinct jobs, with `restaged: 2` and `rescraped: 1`
— the scraped page was genuinely re-fetched rather than replayed. Cleanup
passed with no orphans.

It took four runs to get there, and the first three are the reason this
journey exists:

1. **The journey PUT files to an API route that does not exist.** Files never
   pass through the API — a browser cannot send credentials through a CORS
   preflight and an inbox holds far more than any request body — so the API
   mints a grant and the bytes go to the VM. Typecheck, lint, and the
   selection tests were all green on a call to a route that was never there.
2. **`targetSlug` was dropped in transit.** The start route rebuilds its
   request body rather than forwarding it, because `urls` are scraped there
   and reach the gateway as files. `targetSlug` was added to the contract and
   the gateway but not to that reconstruction, so the gateway derived a fresh
   slug and wrote a *second* memory while the caller was told theirs was
   replaced — the exact failure this feature exists to prevent, invisible to
   every unit test.
3. **A re-run against an undeployed fix**, which proved nothing: the journey
   exercises deployed staging, so a local commit changes none of it.
