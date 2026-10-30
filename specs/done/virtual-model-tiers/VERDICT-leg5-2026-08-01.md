# Leg 5 — RETRACTED verdict, and what is actually established

Written 2026-08-01, **retracted the same day.** Read the retraction first.

## RETRACTION

An earlier version of this file called the tier switch a **proven product bug**.
That claim does not hold, and it is withdrawn.

The dump it rested on is four `balanced` generations appearing after the switch.
Three of them — `google/gemini-embedding-2` and `openai/gpt-5.6-luna` (twice) —
are the INTERNAL embedding and memory models, not a turn's completion:
`gpt-5.6-luna` is `DEFAULT_CLI_MEMORY_MODEL`, and `MODEL_TIERS.balanced`'s
DIRECT targets are only `kimi-k3`, `sol` and `terra`. Memory and embedding work
runs asynchronously AFTER a turn ends, so the previous `balanced` turn's trailing
traffic lands after the switch was posted and is indistinguishable, by timestamp
alone, from the new turn routing on the old tier. `gatewayGenerations` rows carry
no session or turn id, so there is nothing else to key on.

The reasoning that fell over: positive `msAfterSwitch` offsets were read as proof
the rows belonged to the new turn. They are not — they only prove the rows were
created after the POST, which trailing memory work also satisfies.

What makes it worse: runs 3, 4, 5, 7 and 9 all showed the standard turn
TERMINATING FAILED with `OpenAI API error (401)`, producing no completion at all.
If the follow-up turn in the passing run failed the same way, every fresh
generation in that dump is the previous turn's, and the tier was never exercised.
That possibility was never excluded.

**Status: NOT ESTABLISHED.** Same as the original handoff said, for a better
understood reason.

## The evidence

Six live staging runs of `bun run e2e:staging -- --journey virtual-model-tiers`.
Run 6 reached leg 5 with a rewritten, non-racy assertion and produced:

```
no frontier generation ever appeared after the switch — the tier did NOT take effect
fresh=[
  {"tier":"balanced","model":"google/gemini-embedding-2","status":"settled","msAfterSwitch":15575},
  {"tier":"balanced","model":"openai/gpt-5.6-luna",      "status":"settled","msAfterSwitch":17385},
  {"tier":"balanced","model":"openai/gpt-5.6-terra",     "status":"settled","msAfterSwitch":19102},
  {"tier":"balanced","model":"openai/gpt-5.6-luna",      "status":"settled","msAfterSwitch":29182}
]
```

`msAfterSwitch` is each generation's `createdAt` minus the moment the
`tier: 'frontier'` message was POSTed. No `frontier` generation appeared during
the full 300s window. Note the models: only `gpt-5.6-terra` is a DIRECT target
of `balanced`; the other three rows are internal memory and embedding traffic.

The original assertion genuinely was racy — it took the OLDEST new tiered
generation and judged on the first poll where any existed, so a late `balanced`
row failed it either way — and replacing it was right. But the replacement is
still not sufficient, for the reason in the retraction above.

## What IS established

The gateway is cleared, deterministically rather than by inspection:

- `coordinator.tier-switch.test.ts` completes a turn on `balanced`, waits for
  the runner to be killed, delivers a second turn on `frontier`, and asserts the
  spawned tiers are exactly `['balanced', 'frontier']`. It passes. This is the
  SEQUENCE the live journey exercises, and it was previously untested — each
  link was tested alone.
- `apps/api/src/index.test.ts` already asserts a follow-up message dispatches
  with the newly requested tier.
- `process-runner.test.ts` already asserts `--model <tier>` carries `args.tier`.
- `resolveSessionTier` gives `requested` precedence over the session's last tier.

So API → backend → gateway → spawn flag is verified end to end. Anything left is
in the agent's own mapping of `--model` to `x-duet-tier`, or the journey never
measured a real follow-up turn at all.

## What the old dump does and does not rule out

Rules out:
- **The racy assertion.** The replacement polls the whole window.
- **A slow reconcile.** All four rows are `settled`, not `reconciling`.
- **Entitlement clamping.** The workspace is a subscriber, the
  `subscriber-default` leg passes in the same run, and a clamp would have
  produced `economy`, not `balanced`.

Does NOT rule out, and this is the gap:
- **Trailing memory and embedding work from the previous turn.** Three of the
  four rows are exactly that, and it lands after the switch by construction.
- **A follow-up turn that failed and produced nothing.** Five other runs show
  precisely that failure, and the journey did not check the follow-up's terminal
  status before judging its tier. It does now.

## What is confirmed correct in the chain

Traced and read, not assumed:

- `resolveSessionTier({ requested: args.input.tier, ... })` in
  `domains/agentSessions/delivery.ts` resolves the REQUESTED tier for a
  `message` input and stores it as the event's `resolvedModelId`.
- `runnerInputRequest` in `apps/api/src/agent-runner.ts` sends
  `launch.tier = prepared.dispatch.resolvedModelId`.
- `deliverInputUnclaimed` in `packages/gateway/src/agent-sessions/coordinator.ts`
  spawns with `tier: args.launch.tier` — the incoming request's tier, not the
  envelope's.
- `modelEnvForSpawn` carries credentials and URLs only; it contributes no tier,
  so attribution rides on the header the agent derives from its `--model` flag.

So the design the handoff describes is implemented on the fresh-spawn path.

## Suspect ELIMINATED — the live-runner branch

`deliverInputUnclaimed` short-circuits before the spawn when a runner is still
alive, delivering the prompt into that process — which carries the previous
tier. This looked like the culprit, and it is not:

- `coordinator.tier-switch.test.ts` runs exactly that sequence and shows the
  second turn spawning with `frontier`, because the terminal kills the runner
  before the follow-up arrives.
- It would also be CORRECT behaviour if it did fire. A prompt arriving mid-turn
  is steering the running turn, and the settled design is that a tier change
  takes effect on the next turn, never mid-turn.

## Harness changes made to get here

Three, each forced by a measured failure rather than a guess:

1. **Reads reconnect and resume.** A fresh VM's first turn takes ~250s
   (measured `startedInMs: 250896`) while a held SSE connection dies at ~255s,
   so the journey was calling a healthy turn "did not reach a terminal event".
   Reads now run in 120s legs, resume from `last-event-id`, and budget 900s
   overall.
2. **`readEventStream` gained `returnPartialOnTimeout`** (opt-in, off by
   default, so no other journey changes). Without it a timed-out leg discarded
   both its frames and its cursor, and the retry resumed with no
   `last-event-id` — which makes the server stream from NOW rather than
   replaying.
3. **Leg 5's assertion states the real contract**: a `frontier` generation
   appears, and nothing after it reverts.

## The real blocker: a 401 on the turn itself

The standard session terminates `complete` with `status: 'failed'` and

```
Model did not call required structured output tool: recordObservations.
Error: OpenAI API error (401): 401 "unauthorized"
```

on runs 3, 4, 5, 7 and 9 — a majority. Durable ids stay contiguous (`1,2,3,4`),
so nothing is being dropped by the reader; the turn genuinely produces no steps.

**Run 10 settled which cause it is.** The gateway log for a failing run contains
NO `spawn_model_credentials` warning (complete log, `truncated: false`), so the
runner was spawned WITH credentials. The 401 is a key that was present and
REJECTED — not a keyless spawn.

That matters for scope: the keyless-spawn fix (the gateway now queues a turn
until credentials arrive rather than spawning without them) is worth having on
its own, but it does NOT fix this. This is a different bug.

What is ruled out so far:

- **Keyless spawn.** No warning in the log; credentials were present.
- **Tier enforcement.** `attributeTier` blocks with **403**, never 401, so the
  model-gateway's tier check is not the rejecter.
- **Routine key rotation.** `VM_MODEL_KEY_EXPIRES_MS` is 24h against a 2h
  refresh window, and a fresh e2e VM is issued a key with current scopes, so
  `reusableManagedKey` should reuse rather than rotate.

Worth knowing for whoever continues: `rotateVmModelKeyForWorkspace` REVOKES every
existing unrevoked VM model key before issuing the new one, and an agent process
holds its key in env fixed at spawn. So any rotation that does fire kills the
in-flight turn's key. That is a real hazard even if it is not what is happening
here — Example User's call is that the one-turn process lifetime makes env-refresh
machinery unwarranted, so the fix if it ever bites is to avoid rotating under a
live turn, not to refresh env.

### It is OUR gateway returning that 401

`apps/model-gateway/src/index.ts` has exactly ONE 401, at line 86, and its body
is `{ error: 'unauthorized', code: 'missing_api_key' | 'invalid_api_key' }` —
which is precisely the string the agent surfaces. So the memory call reached
Duet's model-gateway and was rejected there, at
`extractApiKeyCredential(request.headers) === null`: **no usable credential on
the request.**

Every static hypothesis is now eliminated by reading the code:

| Hypothesis | Killed by |
| --- | --- |
| Runner spawned keyless | No `spawn_model_credentials` in the gateway log |
| Tier enforcement rejecting the call | `attributeTier` blocks with **403**, never 401 |
| Memory model outside the tier closure | `frontier` AND `balanced` closures both list `gpt-5.6-luna` and `gemini-embedding-2` |
| Agent calling `api.openai.com` directly | `resolveDuetGatewayModel` overwrites `baseUrl` with the Duet proxy route |
| Memory path skipping the auth wrapper | `generateStructuredOutput` calls `resolveProviderApiKey` |
| Env var name mismatch | Agent reads `DUET_API_KEY` / `DUET_GATEWAY_BASE_URL`; `modelEnvForSpawn` sets exactly those |
| Routine key rotation | 24h TTL vs a 2h refresh window, and a fresh VM gets current scopes |

### Settled live against staging

Probed directly rather than reasoned about — a real VM model key minted from the
staging backend, fired at the staging model-gateway:

| Request | Result |
| --- | --- |
| No authorization header | `401 {"error":"unauthorized","code":"missing_api_key"}` |
| Garbage bearer | `401 {"error":"unauthorized","code":"invalid_api_key"}` |
| Well-formed but unknown key | `401 {"error":"unauthorized","code":"invalid_api_key"}` |
| **Valid VM key, memory model, no tier header** | **reaches upstream** — authenticates fine |
| Valid VM key, memory model, `x-duet-tier` the workspace is not entitled to | `402 subscription_required` |

So a valid VM key authenticates for the memory model, and the observed
`401 "unauthorized"` can only be a request that carried **no credential or an
unknown one**.

Key revocation is also ruled out: `testing/internalAdmin:auditEvents` on staging
returns **zero** `api_key.vm_model_key_*` events across its whole audit history.
Nothing rotated, so the key in the agent's env was never invalidated.

### Conclusion

The credential is present in the agent's environment at spawn, it is valid, and
it was never revoked — yet the memory call reaches Duet's model-gateway without a
usable one. **The gap is inside `@duetso/agent` 0.3.8, on the
`recordObservations` structured-output path**, not in this repository.

That is as far as this repo's evidence reaches. Confirming it needs the agent to
log the outgoing `authorization` header (or its absence) for a memory call. The
relevant seam is `resolveProviderApiKey(model.provider)` in
`model-resolution/duet-gateway.js`: it returns `process.env.DUET_API_KEY` only
when `provider === 'duet-gateway'`, and `getEnvApiKey(provider)` — which returns
`undefined` for that provider — for anything else. A memory model whose provider
is not `duet-gateway` at call time would send an empty key and produce exactly
this 401.

### What this means for the tier question

Leg 5 stays open, and it is NOT blocked on a Duet-side defect. It is blocked on
the agent's memory call failing the turn before the tier can be observed. Once a
run gets a follow-up turn that terminates `completed`, the journey's assertions
are now correct enough to settle the tier question in one shot.

Until this is resolved, leg 5 is reached only about half the time, which is why
the tier question is still open.

## Next step

Get one run where the follow-up turn terminates `completed`. The journey now
refuses to judge tiers otherwise, so that run's dump is trustworthy in a way
none of the previous ones were.
