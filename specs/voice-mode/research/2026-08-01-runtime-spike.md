# Voice runtime spike — 2026-08-01 stop/go report

Verdict: **RED / no-go. Slice 03 is not closed.**

The local harness proves that a browser-acknowledged interruption prefix can be
encoded as a shorter playable Ogg/Opus artifact. It now also contains two unrun
same-path Cloud scenarios: one proves a Fish acknowledgement and a later
configured-LLM/Fish response as separate browser-audible epochs, while the
other substitutes the marked response and measures interruption. The first
uses a fixed simulated Main result and therefore does not claim production MCP
latency. A real browser publishes the fixture as
microphone audio, captures decoded LiveKit remote-track PCM through a
pass-through AudioWorklet, and acknowledges it against the audio output
timestamp. No real Cloud sample has run. No
LiveKit project credentials, third public Fish stock-voice ID, or real mobile
Safari device/runtime was available. Therefore this run selects no STT, Voice
LLM, Fish model, Fish voice, production codec/segment mechanism, played-prefix
owner, latency budget, plan, or concurrency level.

The local matrix can now be operated from physical Safari without a second
probe implementation: one fragment-authenticated quick tunnel exposes a
loopback page, and a fixed remote-command allowlist feeds the existing Python
browser decoders. Browser floor is carried through planning, evidence, closure,
and summaries. WebKit shipped `AudioContext.getOutputTimestamp()` in 2020, but
mobile support and uninterrupted audio state remain facts for the physical run,
not conclusions from the local controller. [WebKit implementation record](https://bugs.webkit.org/show_bug.cgi?id=215591).

Downstream Slices 05 and 08 must not treat the candidate mechanism below as a
decision. The Slice 03 stop rule still applies: never retain the full synthesized
response after interruption.

## Checked toolchain and external facts

The locked probe uses Python 3.12, `livekit-agents` 1.6.7, `livekit` 1.1.13,
`livekit-api` 1.2.0, `mcp` 1.29.0, PyAV 18.0.0, and Playwright 1.62.0. Exact
transitives are in [`uv.lock`](../assets/slice-03-runtime-probe/uv.lock).

Provider facts were rechecked against first-party sources on 2026-08-02. The
canonical rationale and volatile values live in
[`livekit-fish.md`](livekit-fish.md); this report keeps only facts that affect
its RED verdict:

- LiveKit Inference currently lists `deepgram/flux-general-en`,
  `assemblyai/universal-streaming`, `google/gemma-4-31b-it`,
  `google/gemini-3.1-flash-lite`, `fishaudio/s2.1-pro-free`, and
  `fishaudio/s2.1-pro`. The first four are benchmark hypotheses, not selected
  models. [STT catalog](https://docs.livekit.io/agents/models/stt/),
  [LLM catalog](https://docs.livekit.io/agents/models/llm/),
  [Fish TTS catalog](https://docs.livekit.io/agents/models/tts/fishaudio/).
- LiveKit's Fish page exposes two public example/default IDs in its static
  documentation (`933563129e564b19a115bedd57b7406a` and
  `b347db033a6549378b48d00acb0d06cd`) and sends readers to a signed-in Fish
  voice library for the rest. A third stock voice was not invented.
- LiveKit says Inference is ZDR by default, including underlying providers, but
  agent observability is separate. `AgentSession.start(..., record=False)` is
  the documented switch that disables audio, transcript, trace, and log upload.
  [Inference ZDR](https://docs.livekit.io/agents/models/inference/),
  [session recording options](https://docs.livekit.io/deploy/observability/insights/).
- Explicit dispatch is still the recommended path and its opaque metadata is
  available in `JobContext`. Root MCP still requires
  `MCPServerHTTP(url, transport_type="streamable_http")` because auto-detection
  otherwise depends on `/mcp` or `/sse` suffixes.
  [dispatch](https://docs.livekit.io/agents/server/agent-dispatch/),
  [MCP](https://docs.livekit.io/agents/logic/tools/mcp/).
- The Build plan currently allows five concurrent agent sessions, five STT
  connections, five TTS connections, 1,000 included agent-session minutes, and
  $2.50 of shared Inference credit, and may cold-start in 10–20 seconds. These
  account defaults were not verified in a project dashboard during this run.
  [quotas and limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/).
- LiveKit currently lists Fish S2.1 Pro at $15 per million characters and S2.1
  Pro Free at $0. The report no longer converts unlike billing units into an
  invented per-minute total; actual Duet request mix and duration must supply
  that estimate. [LiveKit Inference pricing](https://livekit.com/pricing/inference).
- Fish continues to advertise `s2.1-pro-free` through August 31, 2026 with no
  SLA or latency guarantee. Fish says direct requests may be used for model
  improvement; this probe makes no direct Fish requests.
  [Fish S2.1 Pro Free terms](https://fish.audio/ko/blog/s2-1-pro-free-api/?articleLocale=en).
- WebKit says Safari 18.4 added Ogg-container playback for Opus/Vorbis on iOS
  18.4 and later, while its MediaRecorder addition names WebM/Opus rather than
  Ogg authoring. Documentation is not a substitute for the required real-device
  run. [Safari 18.4 media changes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/).

## Evidence produced

The locked harness is
[`slice-03-runtime-probe`](../assets/slice-03-runtime-probe/). It contains no
product runtime imports or topology.

### Heard-prefix candidate, locally falsified and Cloud-ready

The checked spoken fixture is exactly 4,000 ms when decoded. The candidate
ledger accepts only monotonically increasing, 20 ms-aligned browser playout
acknowledgements. At a 1,200 ms acknowledgement it writes a 1,200 ms artifact,
4,453 bytes versus 15,124 bytes for the full synthesis, and projects only
“One two”; the unplayed tail is absent. PyAV decodes both artifacts, and desktop
Google Chrome 150 reports the prefix as 1,207 ms, within the required ±100 ms.

Evidence:

- [`fixture-evidence.json`](../assets/slice-03-runtime-probe/evidence/fixtures/fixture-evidence.json)
- [`four-second.ogg`](../assets/slice-03-runtime-probe/evidence/fixtures/four-second.ogg)
- [`heard-prefix-1.2s.ogg`](../assets/slice-03-runtime-probe/evidence/fixtures/heard-prefix-1.2s.ogg)
- [`chromium-prefix-codecs.json`](../assets/slice-03-runtime-probe/evidence/chromium-prefix-codecs.json)

The tests also cover a mid-word boundary (only complete words survive), an older
or duplicate acknowledgement (the boundary never regresses or grows), disconnect
(finalize at the last acknowledgement), and upload failure (no event is appended
before media upload succeeds).

This is a **candidate mechanism only**: the browser's decoded remote-track PCM
would be the artifact owner, while `AudioContext.getOutputTimestamp()` would
acknowledge the prefix that reached the output device. Absolute audio-frame
coordinates keep leading silence from shortening the spoken prefix, and a
minimum-round-trip clock calibration puts worker milestones on the browser's
performance clock. The runner binds metadata proof, clock RPC, telemetry, and
remote-track capture to the same worker identity. The worker now uses
`AgentSession.say` to play the checked four-second spoken fixture instead of
calling its configured LLM/TTS. A low-level continuous carrier prevents natural
word pauses from being mistaken for the later mute boundary, and partial
evidence names only the STT model actually exercised. PCM stays in
browser/controller memory. The controller encodes the exact captured prefix to
canonical Ogg/Opus, decodes its duration, correlates its normalized waveform
with the beginning of the full marked response, and trims the fixed transcript
cue ledger at the measured playout stop; silence, a shifted segment, or tail
audio mixed into the prefix is rejected. Capture continues beyond the 1.2-second
barge-in boundary through the last audible frame. Ogg may close the final partial
frame internally, but its end granule trims decoded output to the exact stop
sample, so capture and artifact durations are independently checked facts. A
sample persists only timing, sample rates, byte counts, a digest, similarity,
and content-free tail facts. The checked browser now schedules barge-in at the
projected 1.2-second output boundary, waits for 250 ms of output-confirmed
silence, and computes mute latency from the last marked frame. Until a real
Cloud room produces that sample, this remains an unrun mechanism rather than
evidence that mute arrives within 200 ms.

### Desktop Chromium codec result

Google Chrome 150 on macOS decodes and plays
`audio/ogg;codecs=opus` (`canPlayType` = `probably`) but reports that MIME as
unsupported for MediaRecorder, and an Ogg/Opus recording cannot be created.
This eliminates browser MediaRecorder as the Ogg author on this desktop floor.
The evidence controller now proves in-memory PCM encoding, while the production
author and mobile browser floor remain hypotheses until the real runs pass.

Evidence:

- [`chromium-codecs.json`](../assets/slice-03-runtime-probe/evidence/chromium-codecs.json)
- [`doctor.json`](../assets/slice-03-runtime-probe/evidence/doctor.json)

### Static/runtime contract probes

- The fake bound server is served at `/`, and the test reaches exactly
  `main_send`, `main_read`, and `main_cancel` through LiveKit's explicit
  Streamable HTTP transport.
- The checked manifest is the single owner of candidate/scenario/activation
  attempts. Its matrix runner flushes one content-free success or reason-coded
  failure row per attempt. Provider absence remains false unless the operator
  checks the sample-derived, provider-visible room in Agent Insights or a
  provider API and types that room together with the exact local attempt ID.
  Closure rejects missing, duplicate, rebound,
  privacy-pending, and over-budget evidence. A deployment-launcher fingerprint
  inherited by LiveKit job processes makes each claimed cold activation
  falsifiable; the external activation script cannot green the gate by
  returning to the same warm deployment.
- Worker construction pins `record=False` and the two-candidate hypothesis
  families. The explicit `candidate_response` job mode uses candidate STT,
  speaks a fixed Fish acknowledgement, waits for output-clock silence, then
  starts one configured-LLM/Fish paraphrase from a sample-bound simulated Main
  result. The browser measures acknowledgement onset, later response onset, and
  second-animation-frame caption paint against content-free calibrated worker
  milestones. The explicit
  `fixed_interruption` mode uses candidate STT, then plays a marked
  deterministic response without counting configured LLM/TTS/voice IDs as
  exercised models. Both publish only the fixture's first uninterrupted 450 ms
  utterance. The runnable Cloud sample creates a unique room, publishes the
  browser microphone before dispatch, proves the exact worker, and deletes the
  room on success or failure.
- The checked browser bundle publishes only a synthetic microphone source,
  schedules the second utterance from the worker track's output clock, receives
  ordered content-free telemetry, and captures the proved worker's remote audio
  on the render path. Base64 prefix PCM crosses only the in-memory Playwright
  boundary; the evidence writer encodes and validates it before persisting only
  content-free facts. No remote sample was produced in this report.
- The Cloud credential preflight reports the required names as absent. No
  matrix attempt ran and no sample row claims provider evidence.

## Missing proof required to turn green

All of the following remain required:

- A real LiveKit Cloud deployment and unique-room explicit-dispatch sample in
  which the named worker reads its metadata. Run at least 20 warm samples per
  candidate and five true cold activations for the eventual deployment shape.
- Live audio bakeoffs for at least two STT candidates and their endpointing
  settings, including accuracy/error review, plus at least two low-latency Voice
  LLM candidates. No p50/p95 model measurements exist yet.
- LiveKit Inference Fish synthesis for the free and paid S2.1 Pro models across
  at least three real stock voice IDs, including intelligibility review. No
  model or voice can be selected from this run.
- Warm/cold p50 and p95 for startup, end-of-speech to acknowledgement, Main
  complete to first audible audio, barge-in mute, and runtime event to caption.
  None of the four hypothesized p95 budgets has a Cloud sample.
- The fixed four-second/1.2-second interruption through the same LiveKit remote
  track and browser path intended for production, with browser acknowledgement
  correlated to the retained bytes and transcript. This must include mid-word,
  disconnect, duplicate interruption, and upload failure on the integrated path.
- Real supported mobile Safari capture and playback. No iOS runtime or device
  was available; desktop Chrome alone cannot establish the browser floor.
- A post-session LiveKit Cloud dashboard/API check showing no uploaded audio,
  transcript, trace, or log for every `record=False` run. Source and unit tests
  establish configuration, not provider-side absence.
- Project-specific plan, session/STT/TTS concurrency, actual usage cost, and
  cold-start disposition from the account used for the samples.

Until those proofs land as redacted raw samples, the correct outcome is to stop
at this spike.
