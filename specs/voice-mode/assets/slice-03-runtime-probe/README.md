# Slice 03 runtime probe

This directory is a disposable evidence harness, not a product runtime. It pins
the current Python and browser dependency graphs, exercises LiveKit's root
Streamable HTTP MCP client against a fake bound server, and gives the external
stop/go checks a repeatable place to write content-free measurements.

The checked evidence is intentionally incomplete. Read the dated
[decision report](../../research/2026-08-01-runtime-spike.md) before using any
candidate model, voice, codec, or played-prefix mechanism downstream.

## Reproduce the local evidence

Use Python 3.12 through `uv`; do not activate a separate environment.

```bash
uv sync --locked
uv run pytest
uv run ruff check .
uv run mypy

uv run voice-runtime-probe fixtures \
  --source fixtures/four-second-spoken.ogg \
  --output evidence/fixtures

uv run voice-runtime-probe chromium-codecs \
  --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --fixture evidence/fixtures/four-second.ogg \
  --output evidence/chromium-codecs.json

uv run voice-runtime-probe chromium-codecs \
  --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --fixture evidence/fixtures/heard-prefix-1.2s.ogg \
  --output evidence/chromium-prefix-codecs.json

cd browser
bun install --frozen-lockfile
bun test
bun run check-types
bun run build
```

The source fixture is a non-sensitive macOS Samantha rendering at 145 words per
minute of “One. Two. Three. Four. This tail is not heard.” It is checked in so a
fresh checkout measures identical bytes without depending on an operating-system
voice. `source-fixture` documents the normalization path from a replacement AIFF
to exactly four seconds of 48 kHz mono audio. The Ogg muxer runs in bit-exact
mode so regenerating the checked fixture pair produces the same bytes and
hashes.

## LiveKit Cloud evidence

The worker runs locally with:

```bash
uv run python -m voice_probe.launch dev
```

The Dockerfile is the minimal disposable deployment shape for cold-start runs.
Generate the project-specific `livekit.toml` with the LiveKit CLI; do not check
that file or credentials in. The worker identity is
`duet-voice-slice03-probe` and every session starts with `record=False`.

Cloud commands read only these credential names:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_FISH_STOCK_VOICE_ID_3
```

The checked [probe manifest](evidence/probe-manifest.json) is the sole owner of
candidate models, voices, scenarios, activation labels, and sample counts. Two
public Fish IDs are fixed there; the third comes from the named environment
variable because it must be selected from the signed-in stock library rather
than invented. `doctor` reports presence as booleans and never writes values.

Build the browser bundle before running the matrix. The command launches a
visible, unmuted Chrome process for the desktop floor and one loopback probe
controller exposed through an operator-supplied `cloudflared` binary for the
iOS Safari floor. It prints a one-time fragment-secret URL; open that URL on the
phone and tap **Arm mobile probe** once. The secret is removed from the address
bar before the authenticated WebSocket opens, never reaches HTTP, and is never
written to evidence. Authentication also binds the controller to an iOS/iPadOS
Safari user agent and touch platform; desktop browsers and alternate iOS
browsers are rejected before any row can be labeled `ios-safari`. The same
gesture-armed `AudioContext` survives every mobile attempt; the disabled
**Audio armed** control preserves a stable visible ready state. No alternate
tunnel or browser floor exists in this harness.

The checked phone-size controller states are
[arm](../evidence/mobile-controller-shots/mobile-arm.png) and
[ready](../evidence/mobile-controller-shots/mobile-ready.png).

```bash
uv run voice-runtime-probe cloud-matrix \
  --manifest evidence/probe-manifest.json \
  --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --cloudflared /absolute/path/to/cloudflared \
  --browser-bundle browser/dist/index.js \
  --fixture fixtures/four-second-spoken.ogg \
  --cold-activation-script /absolute/path/to/redeploy-and-wait \
  --output evidence/cloud-matrix.jsonl \
  --report evidence/cloud-closure.json
```

After each completed attempt, inspect Agent Insights (or an account-level
provider API where available). The runner asks you to type that attempt's exact
ID together with its provider-visible room name only after confirming there is
no uploaded audio, transcript, trace, or log. The random sample ID derives that
room name, so the dashboard object and local row have one correlation owner. A
blank, mismatched, or non-interactive response leaves that row's privacy gate
false and the final verdict RED; source documentation never auto-confirms
provider-side absence.

The cold-activation script receives no arguments and must return only after a
fresh worker deployment is ready. Its launcher publishes one random,
content-free activation fingerprint inherited by every job process. Closure
requires a distinct fingerprint
for every planned cold attempt, so a no-op script or a warm worker cannot turn
the activation gate green. The manifest's cold candidate is a benchmark shape,
not a production model selection.

Every planned attempt flushes exactly one JSONL row. Provider/browser failures
become content-free reason codes; exception messages never enter evidence. The
closure report refuses missing, duplicate, rebound, failed, or over-budget
rows, reused cold activations, and any row whose provider-absence check remains
pending.

`candidate_response` proves two audible epochs on one decoded remote track. On
final STT, the probe speaks one fixed Fish-synthesized “Okay.” and suppresses
the default LLM reply. After Chrome confirms that acknowledgement plus 250 ms
of output-clock silence, it invokes one sample-bound, single-use
`probe.main_result` RPC. The worker waits for idle, captures content-free
`main_result` and `runtime_event` milestones, and asks the configured LLM and
Fish voice to paraphrase a fixed simulated Main result. This measures provider
response mechanics; it does not claim to measure the production MCP/Main path.
The browser accepts the next audible epoch only after the acknowledgement's
silence anchor and accepts caption paint only from the metadata-proven worker
after two animation frames. Cross-clock intervals add the calibrated clock
uncertainty conservatively. Its row names all four exercised provider
identifiers.
`fixed_interruption` uses the same STT input but replaces only the response with
the marked fixture so the browser can measure and validate the actually-heard
cutoff. It names no configured-but-unused LLM, TTS, or voice.

`summarize` keeps separate attempt, success, and failure counts under each
candidate/scenario/browser-floor population, and names the measured population
beside each metric's percentiles. It never counts a failed attempt as a latency
sample or blends desktop with iOS timing, or provider-path timing with
deterministic interruption timing.

For `fixed_interruption`, the worker bypasses its configured LLM and TTS after
STT and plays the checked four-second spoken fixture through
`AgentSession.say`. A low-level continuous carrier makes real interruption
distinguishable from the fixture's natural pauses. Evidence therefore names
only the exercised STT model; the configured LLM, Fish model, and voice are not
latency evidence.

The `browser/` bundle owns the real-listener side of the same-path run. Its
visible probe page supplies the nonzero caption surface used by the
`runtime_event` measurement. It
publishes the fixture's first uninterrupted 450 ms utterance as a microphone
track, captures decoded remote-track PCM through a pass-through AudioWorklet,
and freezes the output-device-acknowledged prefix in absolute audio-frame
coordinates. From the first audible worker frame it projects the 1.2-second
speaker boundary onto the browser performance clock, schedules a second 450 ms
microphone utterance at that instant, and reports the last carrier-marked output
frame only after 250 ms of confirmed silence. The frozen PCM continues through
that measured stop rather than ending at the earlier barge-in boundary. It
crosses into Python only through Playwright process memory, where it is encoded
to canonical 48 kHz Ogg/Opus and decoded again to validate duration. The
controller compares that
artifact's normalized waveform with the beginning of the full marked response;
silence, corruption, or a shifted segment cannot claim tail exclusion. It then
trims the fixed transcript cue ledger at the measured stop. The Ogg end granule
trims its final Opus packet to the exact captured sample; evidence records
capture and decoded artifact durations separately. The JSONL sample retains
timing, sample rates, byte count, SHA-256, waveform similarity, and content-free
tail facts; it never stores PCM, encoded audio, transcript, worker identity,
room token, or participant token. A successful sample uses scenario
`fixed_interruption`. A mute at or below the 200 ms
hypothesis is `fixed_interruption_mute_observed_only`; a slower measured stop is
`fixed_interruption_budget_failed`. Neither status proves provider privacy, a
completed physical Safari run, a real Cloud retained-prefix run, or any
production model/voice choice. The dated decision report owns those remaining
gates.

The raw-measurement parser rejects transcript, text, prompt, audio, bearer,
token, ticket, authorization, and secret keys at any nesting depth. Fixture
audio lives only under `fixtures/` and `evidence/fixtures/`; Cloud evidence must
never include media or user content.
