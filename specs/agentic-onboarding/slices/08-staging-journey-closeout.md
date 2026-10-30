# 08 — Staging journey and closeout

The only end-to-end evidence for the real LLM path, plus the feature's
closing gates.

## Contract unlocked

A cold signup walks the whole agentic flow against live staging: zero
typing, real recommendations with personalized reasons, the selection
floor, and a persisted purpose.

## API seam

New `packages/test-harness/src/staging-e2e-synthetic`,
registered as `agentic-onboarding` in `staging-e2e-synthetic`, fixture
`browser` (cold identity — the flow only exists for a fresh owner; follow
the `signup-abuse` pattern).

Walk:
1. Sign up → land on `/w/:slug/onboarding`, identity step; name the
   assistant.
2. Tap "Grow my business"; one follow-up screen per question that goal asks,
   counted off the shipped catalog rather than written down — assert exactly
   one chip pre-selected on each and tap Continue with **zero typing** (the
   journey itself proves the no-typing guarantee). Landing on `team` after
   the last press is also the journey's proof that Continue leaves the
   follow-ups step at all.
3. Assert no `knowledge` step ever appears.
4. Team: assert the plain catalog renders immediately; then, within a
   generous window (~30s), assert the rail with **4 recommendation cards,
   each with a non-empty reason** — the journey FAILS if the rail never
   arrives (staging has the gateway key; silent-fallback-forever is the one
   regression hermetic suites can't catch). On failure, first assert the
   plain catalog is still usable so the failure message is precise, then
   fail.
5. Continue disabled at 2 selections, enabled at 3; select 3 (≥1
   recommended, ≥1 from the browse grid).
6. Ready → enter workspace. Assert whoami: `onboardedAt` set, `purpose`
   starts with `"Goal: grow my business."` and matches the composed
   paragraph; agent installs settled.
7. Revisit `/onboarding` → redirects away.

The write-your-own path is covered locally (component tests + e2e variant),
not on staging — it burns no LLM and its semantics are pure client logic.

## Closeout ladder (once, in order)

1. Root `bun run test` — the one full local gate.
2. `bun run e2e:staging -- --journey agentic-onboarding` — consumes real
   staging resources; run once.
3. `review` skill pass (refactor-clean → code-review → write-docs) over the
   full feature diff.
4. Update this spec's README Next Agent Prompt; then `close-spec` archives
   the folder to `specs/done/` once the user calls it shipped.

## Verification

The journey run is the verification. Journey-selection unit test
(`staging-e2e-synthetic`) covers registration.

## Delegated to the implementer

Wait/polling strategy details; the exact whoami assertions available at
journey runtime.

## Stays green

Every other staging journey registration; the full local suite.
