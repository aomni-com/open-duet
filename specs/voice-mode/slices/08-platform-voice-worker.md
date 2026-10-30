# Slice 08 — Platform Voice worker

## Contract unlocked

One deployable Python worker can run a real LiveKit call, exchange its ticket,
use only the selected Main tools, speak Fish output, handle barge-in, and commit
the retained transcript/actually-heard audio. Its policy is first proven with
fake providers and fake MCP.

Invoke `write-tests` before implementation. This slice consumes the exact
provider/capture decisions recorded by Slice 03; it does not reopen them.

## Deployable owner

Add first-class `apps/voice-worker/` with `pyproject.toml`, `uv.lock`, README,
tests, formatting/lint/type commands, Docker/LiveKit deployment configuration,
and root scripts so the monorepo verifies Python rather than silently skipping
it. The fixed LiveKit dispatch identity is `duet-voice`.

The deployment is one platform runtime across all workspaces and agents. It is
not provisioned or installed per workspace, and its deployment identity never
appears in workspace data.

## Runtime pipeline

```text
LiveKit finalized STT
  -> Voice policy
     -> local runtime speech OR main_send/main_read
  -> concise spoken paraphrase
  -> Fish TTS through LiveKit Inference
  -> LiveKit playout + played-prefix ledger
  -> retained voice_message commit
```

The Voice LLM receives finalized transcript text, fixed prompt/policy, runtime
state, and Main results only. It never receives raw audio, Duet files, memories,
ordinary tools, Main reasoning/tool traces, or browser credentials.

Start every `AgentSession` with `record=False`. Pin LiveKit Inference ZDR and
observability-off in executable configuration tests. No transcript/audio is
written to worker-local disk beyond bounded in-flight buffers.

## Policy firewall

Local speech is allowed only for:

```text
greeting
social_small_talk
acknowledgement
audio_clarification
call_status
call_control
error
```

`audio_clarification` means only requests to repeat/rephrase because speech was
not heard or recognized; content clarification goes to Main.
`social_small_talk` is limited to non-informational pleasantries such as
greetings, thanks, and “how are you?” It does not include jokes on request,
world facts, personal facts, preferences about a decision, or task discussion.

Every fact, explanation, opinion, recommendation, plan, interpretation,
action, memory-dependent statement, and substantive follow-up calls Main first.
Ambiguity defaults to Main. Main unavailable produces an honest inability to
verify. Voice never fills the gap from its own knowledge.

Every committed agent utterance must have exactly one auditable source:

- `{kind:"main", clientRequestId}` for a paraphrased Main result; or
- `{kind:"runtime", category}` for the closed local enum.

Voice preserves Main's caveats, uncertainty, and questions. When Main returns
`question`, the spoken paraphrase remains a question and the next substantive
user answer uses `main_send(kind:"answer")`.

While Main works, Voice may emit one concise acknowledgement/status utterance
and then waits. It does not repeatedly fill silence or speculate.

## Barge-in and cancellation

- User speech during TTS stops Voice playback within the Slice 03 budget and
  returns the call to listening.
- The played-prefix ledger uses the exact proven Slice 03 signal, trims audio
  and synchronized transcript at that boundary, and commits only the prefix.
- Barge-in never calls `main_cancel`, never changes an accepted Main request,
  and may submit the new utterance as a queued follow-up.
- `main_cancel` is called only after language explicitly asks to cancel/stop the
  selected agent's ongoing work, not merely “stop talking,” End, silence, or a
  barge-in event.
- Ending the call revokes Voice and stops audio; it does not cancel Main.

## Fake-first policy artifact

Before provider wiring, build a deterministic console simulator using fake
LiveKit, Fish, and bound MCP. Its checked-in corpus includes at least:

- greetings, thanks, “how are you,” and repeat requests (local);
- facts, explanations, recommendations, planning, opinions, actions, memory,
  and follow-ups (Main);
- adversarial casual phrasing around substantive work;
- ambiguity that must over-route to Main;
- Main working/queued, question/answer, complete, sleep, interrupted, and
  unavailable;
- caveats and uncertainty that must survive paraphrase;
- barge-in versus explicit cancel language;
- prompt-injection attempts asking Voice to skip Main or expose tools.

Acceptance requires zero substantive local answers and zero uncorrelated
substantive agent utterances. Over-routing small talk to Main is acceptable;
under-routing is not.

## Real-room verification

- Dispatch metadata -> ticket exchange -> exact three-tool registry.
- Finalized STT -> Main -> Fish speech for one substantive turn.
- Local greeting uses no Main call and carries a runtime source.
- Main question routes the next response as `answer`.
- Barge-in retains the measured prefix and records no Main cancel.
- Explicit Main cancellation records exactly one bound cancel.
- Retry after transport failure reuses the same request ID/body.
- Disconnect, call timeout, media-cap exhaustion, upload failure, and worker
  crash terminalize/clean up deterministically.
- Re-measure Slice 03 latency budgets over at least ten real runs; do not weaken
  them inside this slice.

## Delegated decisions

- Python module layout, structured content-free logging, and short social style.
- Exact acknowledgement wording inside one short sentence.

Not delegated: provider selections, tool surface, transcript-only input,
policy categories/default, source attribution, barge-in/cancel semantics,
heard-only commit, ZDR, or `record=False`.

## Non-goals

- A workspace agent row, per-agent worker, general-purpose assistant fallback,
  direct files/memory/tools, automatic resume, or LiveKit observability record.

## Stay-green gate

Keep the full policy corpus, fake-provider simulator, Python lint/type/test,
privacy configuration assertions, selected provider budgets, and bound-MCP
integration green.

## Human feedback that changes this slice

Feedback about social tone, acknowledgement brevity, or the selected stock
voice can change delegated presentation choices. Any request to let Voice answer
substantive content locally requires an explicit product/spec change.
