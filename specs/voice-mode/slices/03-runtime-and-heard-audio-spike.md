# Slice 03 — Runtime and actually-heard audio spike

Status: **RED / local evidence mechanics complete; external runs pending.** The checked manifest
now drives two hard-cut scenarios through one matrix command. `candidate_response`
proves a Fish-synthesized acknowledgement and a later configured-LLM/Fish
response as separate browser-output epochs. A sample-bound RPC captures the
simulated Main-result and runtime-event anchors; calibrated rows conservatively
measure all three strict response milestones without claiming production MCP
latency. `fixed_interruption` replaces only the response with the deterministic
marked fixture, schedules barge-in at the projected 1.2-second output boundary,
and validates the captured Ogg prefix through the measured stop. Every attempt
preserves one content-free row, and strict closure rejects incomplete matrices,
pending provider privacy, reused cold processes, failed budgets, and rebound
evidence. One loopback controller plus one authenticated quick tunnel now lets
real mobile Safari execute the same fixed command surface and Python decoders;
the authenticated handshake rejects desktop and alternate iOS browsers before
evidence capture, and one gesture-armed audio context persists across attempts.
Browser floor is part of every planned attempt, row, closure check, and
percentile population. Every mechanism remains a candidate until the
Cloud/mobile/provider privacy evidence pass.

## Contract unlocked

A disposable LiveKit Cloud probe produces a dated go/no-go report that freezes
the external runtime choices and proves that interruption can retain only the
agent audio actually played. It does not add production topology.

This is a stop/go slice. Downstream worker and media work may not begin from
unmeasured model IDs, guessed latency, or an assumed playback cursor.

## Probe shape

Create an isolated Python probe under the spec evidence area first. It may
graduate into `apps/voice-worker/` only in Slice 08. Use `uv`, a locked
dependency set, a minimal LiveKit deployment, a console runner, redacted JSON
measurements, and short non-sensitive test utterances.

The probe must exercise:

- explicit dispatch of one named worker into a unique room, with opaque job
  metadata readable only by the worker;
- `MCPServerHTTP(<Duet root URL>, transport_type="streamable_http")` against a
  fake bound server;
- LiveKit Inference ZDR and `AgentSession.start(..., record=False)`;
- at least two current STT candidates and endpointing/turn-detection settings;
- at least two low-latency Voice LLM candidates;
- Fish Audio through LiveKit Inference, including
  `fishaudio/s2.1-pro-free`, one production-grade Fish alternative, and at
  least three stock voices;
- warm and cold call startup, end-of-speech to acknowledgement, and
  Main-result to first audible agent audio;
- interruption while a known four-second response is playing;
- user and agent Ogg/Opus capture/playback across the supported desktop/mobile
  browser floor.

Do not use direct Fish credentials unless measuring the direct API as a
rejected comparison; production selection stays on LiveKit Inference unless
the privacy proof changes.

## Actually-heard proof

The fixed falsification case is:

1. Generate a deterministic four-second spoken fixture.
2. Play it through the same LiveKit/browser path intended for production.
3. Barge in at an acknowledged 1.2-second playout boundary.
4. Stop playback within the selected interruption budget.
5. Persist a candidate retained artifact.
6. Prove the capture reaches the measured last audible frame: its heard duration
   is `1.2s + measured mute latency`, its Ogg end granule preserves that exact
   stop sample, its bytes are strictly less than the full synthesis, and its
   transcript excludes everything after the measured stop.

The report must name the authoritative capture owner and signal: worker
playout position, browser acknowledgement, remote-track capture, or another
measured mechanism. It must cover mid-word interruption, disconnect, duplicate
interruption, and upload failure.

If no mechanism proves the heard prefix, stop. Do not retain the full TTS
response, claim LiveKit recording is equivalent, or defer the question to the
production builder.

## Decision report

Update `research/livekit-fish.md` or add a dated companion report containing:

- exact LiveKit Agents/SDK versions;
- selected STT model and configuration;
- selected Voice LLM and configuration;
- selected Fish model and stock voice ID;
- chosen Ogg/Opus container string and segmentation mechanism;
- authoritative played-prefix capture mechanism;
- warm/cold p50 and p95 samples;
- p95 budgets for barge-in mute, end-of-speech to acknowledgement,
  Main-complete to first audio, and caption render;
- LiveKit plan, session/STT/TTS concurrency, expected cost per call/minute, and
  cold-start disposition;
- provider failure behavior and current free-tier/SLA caveats;
- redacted evidence links and the go/no-go verdict.

Initial hypotheses to validate, not silently accept:

```text
p95 barge-in mute                       <= 200 ms
p95 end-of-speech -> acknowledgement    <= 800 ms
p95 Main complete -> first audio        <= 1.2 s
p95 runtime event -> caption render     <= 150 ms
```

The 60-minute call, 4 MiB/part, and 64 MiB/session limits from the README are
upper bounds. The report may lower them based on evidence.

## Verification

- Run at least 20 warm samples per candidate and five cold activations for the
  selected deployment shape.
- Include raw redacted measurements rather than only averages.
- Verify LiveKit Cloud contains no uploaded transcript/audio/trace/log after
  each `record=False` probe.
- Measure interruption on desktop Chromium and the supported mobile Safari
  floor; record unsupported codecs explicitly.
- Check current official pricing, quotas, model IDs, and Fish terms on the day
  the report is written.

## Delegated decisions

- Benchmark harness layout and non-sensitive utterance wording.
- Final model/voice selection only through the named evidence and thresholds.

Not delegated: LiveKit orchestration, Fish TTS, ZDR, observability-off, Python,
transcript-only model input, the heard-only retention rule, or the stop/go
outcome.

## Non-goals

- Production call/session APIs, credentials, UI wiring, or durable media.
- A fallback provider architecture. A failed candidate is recorded and
  replaced by another measured candidate inside this slice.

## Stay-green gate

The locked Python probe, redacted measurement parser, observability assertion,
codec fixtures, and interrupted-prefix falsification stay reproducible from a
fresh checkout with documented provider secrets.

## Human feedback that changes this slice

Feedback may override the recommended stock voice or a reversible quality versus
latency preference. It does not waive ZDR, observability-off, heard-only
retention, or the stop/go thresholds without an explicit spec change.
