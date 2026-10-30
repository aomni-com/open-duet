# Model workspace selection evidence

Verified on 2026-10-03 against the slice-02 identity implementation. This is local
backend and HTTP evidence; it does not claim harness-client completion or a live
deployment. Controlled upstream responses exercise the real model proxy and a
disposable local Convex deployment. No provider spending or customer state is used.

## Accepted contract

One human key names either explicitly selected workspace. Current membership and
the existing role-derived `services` grant decide spending access. A missing
selector refuses even with one remaining membership; a lost membership, viewer
role, or nonexistent target refuses without generation, rate-limit consumption,
provider forwarding, or debit. Rejoining restores access with the same key.
Bound VM credentials keep their target and reject conflicting selectors.

The HTTP capture covers catalog, chat, embeddings and image requests. Provider
requests contain the platform credential and no `x-duet-workspace`. The refusal
capture has no provider requests or generation rows. Unbillable responses release
their selected generation/reservation without usage charges.

The ledger proof starts two generations with one key, changes the test client's
default before settlement, and observes `ai_generation:human-first` debit **101**
micro-USD in the first workspace and `ai_generation:human-second` debit **202** in
the second. Generation rows retain those workspace IDs. Existing payer
reassignment and reservation policy remain unchanged.

## Verified gates

- From `packages/backend`: `bun test convex/domains/modelGateway/preflight.test.ts convex/domains/apiKeys/authenticate.test.ts` — 10 passed, 48 assertions.
- From `packages/backend`: `bun test src/model-gateway.test.ts src/model-gateway-settlement-selection.test.ts` — 40 passed, 185 assertions.
- From `apps/model-gateway`: `bun test src/index.test.ts` — 64 passed, 494 assertions. After tightening nonexistent-target refusal and adding the real VM-selector conflict check, the changed HTTP case was rerun with `-t 'one human credential targets'` — passed, 24 assertions.
- Both owning packages' `bun run check-types`, focused `oxlint`, formatting and `git diff --check` passed.

Red/green proof observed the original human preflight rejection, missing HTTP
selector transport, and nonexistent-target credential misclassification. Deliberate
mutations removing the machine conflict check, role check, and upstream selector
stripping each failed the matching regression for the expected reason. Restoring
the original all-human rejection also failed the two-workspace ledger acceptance.
All mutations were removed before the final gates.

## Review boundary

The shape review retained one membership/role policy and the existing generation,
reservation and settlement owners. Workspace lookup is indexed and grant derivation
reuses the API-key role owner; it avoids building browser presentation summaries
for every model call. No schema column, credential kind, payer snapshot, ledger
algorithm or compatibility adapter was introduced. HTTP adds one private selector
and the `workspace_mismatch` refusal; implementation pointers live in the
[model-gateway README](../../../../../apps/model-gateway/README.md).

The [client receipt](client-receipt.json) records the separate controlled-wire
check through the harness and AI SDK entry points. The core receives the host's
process selection; [its README](../../../../../packages/agent/README.md) owns that
boundary. CLI configuration integration and live acceptance remain required.
Slice 03 remains open until that end-to-end client seam is proved.
