# Voice mode unknowns map

This map is the output of the pre-spec quadrant walk. It distinguishes frozen
product decisions from evidence still owed by an implementation slice.

## Known knowns

- The entry is a Call icon on the agent card beside Train, not ComposeBar.
- The call is an independent overlay and creates a retained Voice session.
- The visible identity is the selected agent; Voice is an invisible platform
  runtime, not an agent entity.
- The selected agent's default session is the separate Main reasoning/memory
  channel.
- Voice may handle small talk and call mechanics. Every substantive response
  must first consult Main, then be paraphrased for speech.
- Transcript and audio are message content. User audio is retained; agent audio
  is retained only to the point played.
- A per-turn Voice marker causes a mechanical ASR-fallibility reminder for Main.
- Barge-in stops Voice playback, not Main work.
- Each activation is a new call; resume is a nice-to-have and out of scope.
- Simplicity beats a general voice framework. There are no compatibility or
  legacy rails.

## Known unknowns

| Unknown | Owner | Evidence that closes it |
| --- | --- | --- |
| Exact STT model and language configuration | Slice 03 | Dated latency/error bakeoff |
| Exact low-latency Voice LLM | Slice 03 | Warm/cold first-token and policy-eval report |
| Fish model/voice fit for production | Slice 03 | LiveKit Inference audio samples and TTFA data |
| Exact “played audio” capture point | Slice 03 | Interrupted 4-second fixture retaining only a 1.2-second prefix |
| Ogg/Opus capture/playback support on the supported browser floor | Slice 03 | Desktop/mobile codec matrix |
| Main output correlation across queued work | Slice 04 | Race fixture covering all terminal states |
| LiveKit worker cold-start and plan sufficiency | Slice 03 | Cloud deployment samples and concurrency/cost report |
| Real-audio staging automation stability | Slice 10 | Prerecorded publisher in the selectable journey |

## Unknown knowns surfaced by repository inspection

- `AgentRosterCardView` already receives both `launchable` and `locked`; Voice
  does not need a second eligibility model.
- `AgentsWorkspace` renders desktop/mobile roster variants and is the natural
  single overlay owner.
- The existing playground already imports the production roster card and has
  desktop/mobile visual coverage.
- Default-session message delivery already has durable `clientRequestId`
  deduplication, but new-session `201` and existing-session `202` response
  shapes differ.
- `run_agent` creates a fresh root session, so it cannot preserve the selected
  agent's default-session memory.
- The hosted MCP server is rooted at `/`; LiveKit must be told
  `transport_type="streamable_http"` explicitly.
- The gateway has one durable prompt-composition seam used for live delivery
  and replay; injecting the ASR reminder elsewhere risks replay drift.
- Session deletion is already bounded and idempotent. A new audio owner must
  join that cascade rather than inventing independent cleanup.
- LiveKit browser networking would bypass the current bare-fetch boundary
  checker unless `livekit-client` imports are restricted to one owner.
- Existing text session rows require prompt/title fields. Voice creation needs
  a dedicated system-owned session creator, not a fake spoken user message.

## Unknown unknowns and containment

| Possible surprise | Containment rule |
| --- | --- |
| LiveKit playout events do not expose a trustworthy heard boundary | Slice 03 stops the build; no full-output retention fallback |
| A queued Main turn has no durable output boundary | Slice 04 adds a receipt/correlation field before MCP is built |
| Free Fish access changes after August 31, 2026 | Provider choice is config selected by evidence, not architecture |
| Dispatch metadata is missing on Cloud deployment | Prove it before credential work; do not pass the ticket through the browser silently |
| Worker credential expires mid-call | Fixed call TTL bounds the credential; no refresh family in v1 |
| Main asks a question while newer voice speech arrives | `main_read` returns `question`; only `main_send(kind:"answer")` resolves it |
| Retained media cap is reached | Stop retaining later audio, keep the call alive, disclose the retention failure in ended state, and record a content-free metric |
| Page closes while Main still works | End/revoke Voice only; Main continues and may complete in its default session |
| Agent becomes unavailable after activation | Voice reports it cannot verify, then remains available for End/Close; no knowledge fallback |

## Fog burned off by slicing

- “Build the worker” became separate evidence, correlation, credential, policy,
  runtime, and browser rungs.
- “Save the response audio” became a falsifiable interrupted-playout proof.
- “Reuse MCP” became an agent-bound server projection with exactly three tools.
- “Voice checks Main” became a closed local-speech enum plus default-to-Main
  evals and source attribution on every agent utterance.
- “Retained Voice session” became an ordinary selected-agent session plus a
  one-to-one `voiceCalls` lifecycle owner, avoiding changes to existing rows.

## Deferred, not unknown

- Resuming an ended call. If later added, the Voice runtime receives a trusted
  system reminder that it is picking the call up again; it must not infer
  continuity from partial transcript context.
- Pairing a Voice session to a Main session in the user interface.
- Telephony and multiple participants.
- Custom cloned voices.
- Voice on the agent detail header or anywhere outside roster cards.
