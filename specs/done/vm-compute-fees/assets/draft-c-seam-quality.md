# Draft C — seam-quality bias (claude)

> Returned inline by the drafting agent and archived here verbatim for
> provenance. Synthesized into the canonical ladder in `../README.md`; where
> this draft's slicing differs from the ladder, the README wins.

## Unique findings this draft contributed to the canonical plan

Recorded at the top because they are the reason this draft mattered — each was
found by this draft alone:

1. **The Convex fake exe has no `stat`.** `domains/workspaces/vmExe.ts:29-78`
   returns an in-memory fake when `DUET_TEST_FAKE_EXE=1`, and `WorkspaceVmExe`
   is `Pick<ExeClient,'create'|'list'|'remove'|'resize'|'restart'|'setSharePublic'>`.
   Without adding `stat` to that fake, **no integration test can ever exercise
   the sampler** and the fee path is only testable against live exe.dev. This is
   the single most important testability fact in the recon; it is now part of
   slice 04's definition of done.
2. **The fee candidate set cannot be `status === 'active'`.**
   `markUnhealthyWorkspacesImpl` flips a workspace to `unhealthy` when its
   gateway stops phoning home — the VM keeps running. Copying the size sweep's
   query would let an abuser escape metering by killing the gateway, which is
   the exact failure mode provider-side metering exists to defeat.
3. **`VmTelemetrySampleSchema` derives from the gateway *request* schema**
   (`contract/src/vm/index.ts:31` extends the inbound `VmTelemetryMetricsSchema`).
   One schema owns two unrelated contracts; deleting the in-VM rail silently
   rewrites the chart's public response shape unless they are split first.
4. **Four existing answers to "which workspaces belong to this payer"** —
   `birth.ts:84` (owner memberships), `userBilling.ts:320`, `subscriptions.ts:105`,
   `vmDiskPolicy.ts:29` (which also skips archived). Decision 12 adds a fifth
   unless a slice names an owner and deletes the old gate.
5. **`currentDayKey()` already exists** returning `2026-08-09`, and is already
   the daily usage-rollup key. This became the decision-6 amendment.
6. **A fresh VM measures 7.449 GB against a constant of 8**, so the storage
   subtraction must clamp at zero or the bar goes negative.

## Objections raised (recorded, not acted on)

- **Objection 2 — decision 17 (teardown stats) buys under an hour of coverage
  for a real ordering hazard.** With an hourly sampler the uncharged tail is at
  most one interval (≈$0.003 idle, ≈$0.10 saturated). The alternative — charge
  the final day from stored samples only, no `stat` on the delete path — removes
  a provider call from the one path where a failure interacts with landmine 7.
  Slice 07 is deliberately structured so the `stat` call is a prefix; dropping it
  later removes three lines and changes nothing else.
- **Objection 3 — decisions 12 + 14 make the limit unenforceable in the
  direction that matters.** A max user can create ten workspaces, downgrade, and
  keep all ten. The mitigation is real but comes from *servicing*, not from the
  limit: a lapsed subscriber loses entitlement, so all ten pause and get
  decommissioned by the existing cron. The README records this so the safety is
  documented rather than coincidental.
- **Objection 4 — decision 3 plus decision 22 means the storage bar is wrong by
  exactly one constant, forever.** Every future image change silently
  re-baselines every user's bar. A hedge that needs no image-version tracking:
  derive the baseline per VM as the minimum `fsUsedGb` ever observed. Not
  planned — decision 3 is explicit — but slice 03's clamp test is written so the
  day the image passes 8 GB, a test fails instead of a bar lying.

## Full draft

The complete draft's slice graph (S0–S11), dependency diagram, kill gates,
single-owner table, nine risks, and per-seam test matrix were folded into
`../README.md` and the slice files. The distinctive contributions are captured
above; the ladder itself is the canonical artifact and is not duplicated here.

Notable structural calls this draft made that the canonical ladder adopted:

- Split the exe typing (S0) from the pricing kernel (S1) from the schema
  cutover (S2), so the storage-bar landmine is verified in isolation and cannot
  be masked by a sampler bug.
- Keep the provider read (S3) strictly separate from the charge (S5), so a
  rate-limit or revoked scope produces *missing samples* rather than a
  partially-billed day.
- Delete `lastTelemetrySampleAt` rather than repurpose it: the newest stored
  `at` is the watermark, and a denormalized copy is a second owner of "what is
  stored".
- Order S3 before S4 so there is never a moment with no telemetry source.

Notable calls the canonical ladder did **not** adopt:

- Splitting the workspace limit into create (S9) and transfer (S10) slices. Same
  owner, same refusal shape, one review — merged into canonical slice 09.
- A hard `VM_USAGE_MAX_POINT_GAP_MS = 20 * 60 * 1000` constant. The canonical
  plan keeps the clamp (under-bill, never over-bill) but sets its value from
  slice 00's measured gap distribution rather than from a guess.
