# Choices ledger — large file uploads

Every decision made without you, re-audited against the **final shipped code**
rather than the pass it landed in. Grouped by verdict, least-confident first.

## Settled by the user

### 1. The refusal reads `"32.0 GB"`, not `"32 GB"` — accepted

`formatBytes` hard-codes one decimal on the GB branch, so the compose-bar chip
reads "Over 32.0 GB" and the Drive notice "…larger than the 32.0 GB upload
limit." Three independent drafters found this and all three declined to fix it,
because `formatBytes` has ten call sites and every one sits inside a committed
screenshot baseline — trimming the `.0` redraws the drive listing, file cards and
knowledge map for a cosmetic win unrelated to this feature.

**Accepted as-is (2026-08-25).** Left alone deliberately, not by omission: the
trailing `.0` is the cost of deriving the copy from the constant rather than
writing the number twice, and that trade was judged worth it.

### 2. Spanish gets a period where it wants a comma — accepted

`formatBytes` is locale-blind, so `es-419` renders "32.0 GB". Same root cause.
The honest fix is making the formatter locale-aware everywhere — larger than this
feature. A locale-aware formatter used *only* by these two strings would
reintroduce exactly the drift that interpolating the constant exists to prevent.

**Accepted as-is (2026-08-25).** If `formatBytes` ever becomes locale-aware, this
string needs nothing — it already interpolates.

## Sound, but worth knowing

### 3. The cap only ever fires for Pro and Max

32 GB exceeds a Starter workspace's entire 20 GB of storage, so those users always
meet `storage_full` first and never see `file_too_large`. Not a defect — but
"the per-file limit is 32 GB" is only true for two of three plans, and it is why
the copy gives no advice.

### 4. A drop is refused whole, not file-by-file

One oversize file in a drop of twenty refuses all twenty, before any byte moves.
The kinder alternative — skip the offender, upload the rest — needs a different
outcome shape. Chosen because "zero bytes sent" is only meaningful if the whole
gesture is refused at pick time. The compose bar is deliberately asymmetric,
refusing per chip, because it has one chip per file with its own status.

### 5. `pathPrefix` is required, and `''` means the drive root

An omitted prefix could have defaulted to the root. It does not: a missing field
would silently grant the whole drive, so the root must be named explicitly. This
surfaced when a relocated lifecycle test posting `{}` began failing validation
before it reached the lifecycle check.

### 6. Staging's contract test was re-specced rather than my change weakened

Their test required "non-root" of both a download path and an upload prefix —
true while the only caller was MCP generated media, always a subfolder. A
*download* names a file and no file is the root; an *upload* names a folder and
the root is the one the Files tab uses constantly. I changed their test.

### 7. The undeclared-body hole is held open by a test

A request with no `Content-Length` is not measured against the cap. This reads as
a bug to anyone seeing the route cold, so the test name says it is deliberate.
Consequence recorded honestly: the limit is exact for browsers, advisory for a
hand-rolled chunked client, and the docs say so.

### 8. The four relocated API tests stayed in `sessions.test.ts`

They were the only route-level grant coverage in the API. They stayed put —
renamed and re-pointed — because each suite file boots its own Convex deployment
and a new file costs another boot in every closeout run. The `describe` is now
slightly off-topic; splitting it later is free.

### 9. `uploadErrorCode` reads a string `code` structurally

An `instanceof`-only recognizer would have broken an existing test that rejects
with a plain `Error` carrying a `code`. Its companion `uploadErrorStatus` *is*
`instanceof`-gated, so a code is never trusted without the status qualifying it —
which is what let `isStorageFullFileError` keep its exact behavior. `uploadErrorStatus`
was added despite the plan saying not to add it speculatively: without it, the
`instanceof` duplication being collapsed would have stayed in `storage-surfaces.tsx`.

### 10. The ceiling probe runs first in the journey, and logs as it learns

It needs only a workspace and a grant. Sitting it behind the composer legs meant
an unrelated failure stopped it running at all — which happened twice. It now
runs first and prints its finding rather than only returning it, so a later leg
failing cannot take the answer with it.

## Reversed by later work

### 11. The endpoint this work built was deleted before shipping

It minted a folder-scoped grant at `POST …/uploads/drive-grant`. Staging landed
the same seam for MCP file resources while this was in flight. Publishing both
would have been the duplication the plan forbade, so `files.uploads.create`
survived and ours was removed. **If you would rather have had ours, this is the
decision to revisit** — but theirs also mints downloads, which ours never did.

### 12. Browser-side actor stamping was deleted

This work found Files-tab uploads landing as `system` and fixed it by stamping
`x-duet-actor-context` in the browser. Staging independently fixed it server-side
by putting the actor in the grant, which a client can neither spoof nor forget.
Mine was removed as redundant; the header remains supported by the transport for
callers that set it.

### 13. `RestFileSystemProvider` no longer takes a required actor argument

Making it required was the right call while attribution was the browser's job —
the regression happened *because* it was optional. Once the grant carried the
actor, the argument was ceremony, and it went.

## Mistakes made and corrected

### 14. An earlier commit swept 19 unrelated files into this branch

`git add -A apps/web` during the client-precheck pass captured in-flight work on
checkout-celebration, knowledge-map and agents-rail that happened to be in the
tree. All were reset to staging's finished versions during the merge. Nothing of
yours was lost, but the commit history for that pass is wider than its message.

### 15. `ui:approve --force` is not scoped to what changed

Twice a sub-threshold visual pass hid a real pixel change; forcing it to see the
change rewrote ~25 unrelated baselines both times. Reverted to the two intended
shots each time. Worth knowing before anyone reaches for `--force`.

### 16. Unrelated formatter drift shipped in two API files

`oxfmt --write` over `apps/api/src` reformatted `agent-runner.test.ts` and
`vm-poll-interval.ts`, which this feature never touched. Kept per the repo's
leave-it-better rule and named in its commit.

### 17. The staging probe shipped broken twice before it answered

First it sat too late in the journey to ever run. Then it went out
unauthenticated — `bearerJson` returns a `Headers` instance and I spread it into
the request init, which yields nothing, so the mint came back 401. Both fixed;
the third run produced the answer.
