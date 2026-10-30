# Choices ledger — final

Every decision made where the spec was silent, re-audited against the code that
actually shipped. Ranked least-confident first: read the top two, skim the rest.

---

## Needs your eyes

### 1. Trained memories reach models differently now — including ones that already exist

`optimizeObservationsForContext` strips bracketed text, collapses runs of
spaces, and deletes `->`. It was running over the whole memory pack, trained
memories included. So every memory in every workspace has been arriving at the
model with its markdown links reduced to bare URLs, its nested bullets
un-nested, and sentences like "Backfill -> excluded" silently rewritten to
"Backfill excluded".

Those rules are right for what they were written for — the observer's own
`[tag]`-and-arrow telemetry — and wrong for an authored document. The optimizer
now applies to the two observation layers only; the stored layer renders
byte-for-byte.

**Why this needs you:** it changes what models see for memories that already
exist, not only ones trained after the release. Nobody asked for that, and it
lands the moment the agent is published. It is a fix, but it is a live-data
behavior change discovered mid-implementation rather than one you signed off.

*Reversible: one call site.*

### 2. Inline code renders with visible backticks

Tailwind Typography's `prose` inserts `` ` `` through `code::before/::after`, so
a memory containing `` `POST /v2/meters` `` displays the backticks. I left it
alone: sessions, the files preview, and marketplace all render this way, so
changing it here would make memories the odd surface out — but it is a one-line
override if you would rather they were clean.

---

## Sound

### Where the work landed differently than the spec described

**The agent release grew a fourth edit.** Instructing the model to write
markdown while the pipeline mangled markdown would have shipped mangled
markdown, so decision 1 above became part of that slice instead of a follow-up
nobody would have filed.

**The API surface is four routes, not two.** The contract's parity test
requires an agent-scoped twin for every root `train.*` endpoint. That is exactly
right — an agent's memories live in the agent's own scope — but it means the
seam is twice what the spec's "two routes" described.

**A dedicated visual fixture was written and then deleted.** I added a
`train-memory` playground before finding that `spa-shell` already owns a
memory-detail scenario with read and edit steps. Two fixtures for one page is
the sediment the next reviewer removes, so the existing scenario's record now
carries markdown, sources, and a model instead — which is why its baselines
moved. That scenario also stopped returning a running job, because the shared
fixture's running job disabled Retrain for a reason unrelated to reading a
memory and left the enabled button with no visual at all.

**A named `retrain-memory` staging journey was added rather than extending the
existing train leg.** Train's live coverage sits inside the ~60-minute full run,
so this feature could not otherwise be verified without paying for all of it.

### Decisions inside the code

**Memory paragraphs override the shared markdown renderer.** Synthesis
hard-wraps prose at around eighty columns, and the shared component preserves
newlines so a chat message shows what someone typed — so every memory paragraph
broke mid-sentence. Memories now follow markdown's own soft-wrap rule; chat is
untouched. The screenshot caught this; no unit test could.

**Sources project on the single-record read only.** Resolving a scrape's URL
means opening the archived copy; on the record list that is one read per
archived markdown file, per memory, per render.

**One manifest read serves both `hasArchive` and the source list**, and
`toTrainRecordSummary` became a pure function taking the boolean.

**A named-but-missing archived file is omitted rather than fatal.** The manifest
records what was archived, not what still exists — pruning is the state
`hasArchive` exists to describe.

**Every miss on the source route returns the same 404** — absent, traversal,
symlink escape, no archive. Distinguishing them would answer "what exists
outside the archive?" for anyone who asked. Confinement compares real paths
rather than string prefixes, because a symlink planted under `files/` passes a
lexical check.

**Preview truncates at 2 MiB with a header saying so; downloads never
truncate.** An archived file can reach the 1 GiB inbox cap: an uncapped preview
is a hung tab, and a clipped download is a corrupt file.

**Restage validates the incoming set against the caps before deleting
anything**, so a refusal leaves the inbox intact rather than destroying it on
the way to failing. It then clears fully before copying, because a half-old,
half-new corpus is worse than an empty one.

**The gateway stages everything and re-scrapes nothing.** Firecrawl credentials
live in the API. That split is what makes the fallback free: the archived copy
is already in place, so a failed re-scrape is a no-op rather than an error path.
A missing Firecrawl key therefore reports every URL in `fellBack` and still
succeeds, unlike the add-a-URL route's 503 — there nothing can be staged, here
there is a working corpus either way.

**The retrain target lives in the URL.** "Retry training" is the Train button
relabeled after a failure, so click-scoped state would vanish exactly when the
user retries.

**`ledger.start` took an options object** rather than a fourth positional
argument, and the retrain slug is persisted on the job snapshot so a restarted
gateway still installs over the memory the user chose.

**The frontmatter reader moved into its own module** now that the inbox and the
archive ask the same question of the same bytes; the shared version returns the
whole scrape triple rather than just the URL.

**A second XML-attribute escaper was added on purpose.**
`observation-groups.ts`'s escapes only `"` and round-trips through a parser that
never unescapes, so widening it would turn a `&` in a cwd into a literal
`&amp;`. The prompt rendering is one-way and escapes completely.

**`encodePathSegments` now has one owner in the API client.** The whole-spec
review found the per-segment idiom three times, one of them pre-existing.

---

## Accepted costs

**A note written to the file store shows the "sources are no longer available"
sentence.** Your call during the walk. Only an in-workspace agent calling
`duet memory add` against a store reaches it — the API's own add route writes to
the DB — so it is rare, and `kind` on the wire is the fix if it ever surfaces.

**`parseObservationGroupAttributes` never unescapes attributes**, so a cwd
containing `"` already round-trips as a literal `&quot;`. Pre-existing, and
fixing it means changing the parser rather than the escaper.

**The "list performs no frontmatter reads" test asserts the contract, not the
syscalls.** The stronger version I considered — make archived files unreadable
and check the list still works — would pass even if someone added a sniff that
swallowed its own errors, which makes it a blind test rather than a strict one.

**`screenshot-critique` was not run.** It works by delegating to a fresh
unprimed subagent, and this session is configured not to spawn them. I reviewed
both viewports myself, and the paragraph defect above is what that review
caught — but treat the visual sign-off as one pair of eyes, not two.
