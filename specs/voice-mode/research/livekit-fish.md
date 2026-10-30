# LiveKit and Fish Audio research

Checked: 2026-08-02. Pricing, limits, model IDs, and the Fish free window are
volatile; recheck them when the external matrix runs.

The first implementation run is recorded in the
[2026-08-01 stop/go report](2026-08-01-runtime-spike.md). It is RED: local
codec/prefix harness evidence exists, but Cloud, model, privacy, and real mobile
Safari samples are still missing, so none of the evidence-conditioned choices
is frozen.

## What Fish launched

Fish Audio launched S2.1 Pro Free on June 23, 2026. It is a text-to-speech API,
not a complete duplex voice-agent API. The announcement says the model string
is `s2.1-pro-free`, supports 83 languages, has no hard character cap under fair
use, and currently remains free through August 31, 2026. It also explicitly
offers no SLA or latency guarantee, and direct Fish requests may be retained
for model improvement.

The free route is not the production contract. Fish recommends paid
`s2.1-pro` when TTFA (time to first audio) and data-processing guarantees are
required. Direct Fish pricing currently lists both models by input bytes, while
the LiveKit route lists them by characters; both list the production model at
$15 per million and the free model at $0.

Sources: [Fish Audio — S2.1 Pro Free API](https://fish.audio/ko/blog/s2-1-pro-free-api/?articleLocale=en),
[Fish model guidance](https://docs.fish.audio/developer-guide/models-pricing/choosing-a-model),
[Fish pricing and rate limits](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits/).

Therefore Duet still needs STT, VAD/turn detection, a fast Voice LLM,
interruption handling, room transport, Main delegation, and retained-media
ownership. “Free” is useful for the prototype, not a production invariant.

## Why LiveKit is the orchestration candidate

LiveKit Inference exposes Fish Audio without a separate Fish key. The catalog
owns the exact model IDs; the production and free S2.1 variants are both
present. Default stock voices are supported, while custom/community Fish voices
require the direct plugin. The exact stock voice remains a measured Slice 03
choice.

Source: [LiveKit Fish Audio TTS](https://docs.livekit.io/agents/models/tts/fishaudio/).

LiveKit Inference is zero-data-retention by default for prompts, audio, and
model outputs sent to its model providers. This is separate from LiveKit agent
observability.

Source: [LiveKit Inference — zero data retention](https://docs.livekit.io/agents/models/inference/).

Agent observability defaults to uploading audio, transcripts, traces, and logs
with a separate retention window. Duet must start every worker session with
`record=False`; a configuration test pins this. Documentation establishes the
control, not its execution. The external matrix still requires an operator to
check Agent Insights after each attempt and bind that absence to the attempt
row. LiveKit's documented Analytics API is Scale-only and does not expose a
portable lower-plan replacement for that check.

Sources: [LiveKit agent insights and recording options](https://docs.livekit.io/deploy/observability/insights/),
[LiveKit Analytics API](https://docs.livekit.io/deploy/admin/analytics-api/).

LiveKit's first-class MCP toolset is currently Python-only. Because Duet serves
streamable HTTP at the canonical root rather than a `/mcp` suffix, the worker
must construct `MCPServerHTTP(url, transport_type="streamable_http")` instead
of relying on URL auto-detection.

Source: [LiveKit MCP tools](https://docs.livekit.io/agents/logic/tools/mcp/).

Explicit agent dispatch can carry opaque job metadata and only applies when a
room is first created. Every call therefore uses a unique room and sends the
one-time worker ticket in the named worker dispatch metadata.

Sources: [LiveKit agent dispatch](https://docs.livekit.io/agents/server/agent-dispatch/),
[LiveKit room configuration](https://docs.livekit.io/reference/other/roomservice-api/).

The Build plan currently permits five concurrent agent sessions, five STT
connections, and five TTS connections, and may cold start a worker with 10–20
seconds of delay. It includes 1,000 agent-session minutes and $2.50 of shared
Inference credit. The checked matrix runs sequentially, so its hypothesis does
not depend on more concurrency, but actual account limits and spend still need
dashboard evidence. LiveKit currently lists Fish S2.1 Pro at $15 per million
characters and S2.1 Pro Free at $0; cost per Duet call cannot be frozen until
the real request mix and durations are measured.

Sources: [LiveKit quotas and limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/),
[LiveKit Inference pricing](https://livekit.com/pricing/inference).

## Current external readiness

The checked `doctor.json` is deliberately content-free: it records that the
LiveKit URL/key/secret and third stock-voice ID are absent without writing their
values. The current workstation also has no `cloudflared` or LiveKit CLI binary.
Those are operational inputs to the disposable probe, not reasons to add a
second provider path or weaken the evidence gates.

## Unknowns not answered by documentation

- Which STT and fast LLM meet Duet's measured latency and accuracy needs.
- Whether `s2.1-pro-free` has acceptable p95 first-audio latency and reliability.
- Which Fish stock voice is understandable across the supported languages.
- Whether the real account's Agent Insights remains empty for every
  `record=False` attempt; source documentation is not provider-side evidence.
- The exact SDK/browser boundary that proves only played agent audio is saved
  after a barge-in.
- The supported-browser Ogg/Opus capture and playback matrix.
- Real project cost and concurrency under Duet's expected call distribution.

These are Slice 03 outputs. Documentation alone does not close them.
