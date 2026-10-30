# Strict-schema audit — final evidence

Measured 2026-07-27 for `AO-STRICT-AUDIT`. The audit applies the onboarding
schema invariant repo-wide: declared fields validate hard, but a field unknown
to the reader never makes an otherwise valid input fail.

Default Zod objects accept and strip unknown fields. Pass-through is reserved
for authored content or persisted/forwarded envelopes that an older reader
must rewrite without erasing fields introduced by a newer writer.

## Before / after by package

The “rejecting Zod” count is `.strict()` plus `z.strictObject`. “Manual
rejection” counts readers that enforced an exact record key set without Zod.
“Pass-through” counts `.loose()` and `.passthrough()` calls.

| Package / scope | Rejecting Zod before → after | Manual rejection before → after | Pass-through before → after |
|---|---:|---:|---:|
| `packages/contract` | 177 → 0 | 1 → 0 | 11 → 7 |
| `apps/api` | 1 → 0 | 0 → 0 | 1 → 0 |
| `apps/web` | 1 → 0 | 0 → 0 | 0 → 0 |
| `packages/backend` | 4 → 0 | 0 → 0 | 0 → 0 |
| `packages/gateway` | 0 → 0 | 1 → 0 | 0 → 0 |
| `apps/lander` | 0 → 0 | 0 → 0 | 3 → 0 |
| `packages/test-harness` | 0 → 0 | 2 → 0 | 0 → 0 |
| `packages/skills-registry` | 0 → 0 | 1 → 0 | 0 → 0 |
| all other `apps`, `packages`, `scripts`, and `tools` | 0 → 0 | 0 → 0 | 0 → 0 |
| **Total** | **183 → 0** | **5 → 0** | **15 → 7** |

The 177 contract occurrences were 164 `.strict()` calls and 13
`z.strictObject` calls across 19 files. The other six rejecting Zod calls were
one in `apps/api`, one in `apps/web`, and four in `packages/backend`.

The five manual readers were:

- approved-model pricing keys in `packages/contract`;
- the gateway session-ledger `strictRecord` helper (four call sites);
- two staging app-key diagnostic readers in `packages/test-harness`;
- the authored `SKILL.md` frontmatter validator in `packages/skills-registry`.

The staging diagnostics still reject the explicitly known `apiKey` field
because a secret crossing that seam is a semantic security violation, not an
unknown-field rejection. Benign newer diagnostics are accepted and stripped.

## Schemas that remain `.loose()`

| Schema / member | File | Why unknown fields must survive |
|---|---|---|
| `AgentOnboardingSchema` chat member | `packages/contract/src/agents/index.ts` | Authored `agent.json` content may be read and rewritten by a version older than the authoring surface. |
| `AgentOnboardingSchema` app member | same | The nested authored onboarding object needs the same read/rewrite preservation as its parent config. |
| `AgentConfigSchema` | same | The complete synced `agent.json` grammar must preserve fields added by newer writers. |
| `AgentStateMachineProgressSchema` | `packages/contract/src/agent/index.ts` | Runner-owned progress is persisted in the gateway session ledger and rewritten during recovery. |
| `AgentStoredMessageSchema` | same | Runner-owned message documents are persisted in the gateway session ledger and must round-trip intact. |
| `GatewayRunnerInputRequestSchema.launch` | same | Launch data is persisted and forwarded across independently deployed API and gateway versions. |
| `GatewayRunnerInputRequestSchema` | same | The outer runner request is a forwarded wire envelope spanning independently deployed readers and writers. |

Each call has a one-line seam comment immediately above it. No
`.passthrough()` calls remain.

The gateway session ledger is a manual validator rather than a Zod schema. Its
envelope, launch, checkpoint, command, wake, and relay records now validate
their declared fields and preserve unknown fields through a disk
read-and-rewrite.

## Final state (repo-wide sweep, 2026-07-27)

The sweep that this inventory anticipated was carried out. Counting non-test
sources across the repo afterwards: **183 rejecting schemas → 1.**

The single survivor is `packages/contract/src/shares/index.ts` — both branches
of the `Share` union, which has no discriminant field and therefore resolves by
each branch refusing the other's payload. Strip made the first branch accept
everything and silently drop `tokenPrefix`.

Seven `.loose()` pass-through schemas remain, each commented in place: the
`agent.json` grammar and its onboarding members, the gateway launch wire and
its envelope, and two runner-owned ledger documents — all cases where a field
written by a newer writer must survive a read-and-rewrite by an older reader.

Two rejections were replaced rather than kept. The hosted MCP `train_start`
now declares its byte-bearing fields `z.never().optional()`, an explicit
deny-list: unknown future fields pass, forbidden ones fail loudly. That is what
its strictness had been approximating.
