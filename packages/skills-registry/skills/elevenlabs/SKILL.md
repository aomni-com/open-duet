---
name: elevenlabs
target: both
description: Generate and transcribe audio through ElevenLabs' HTTP API — text-to-speech voiceover, multi-speaker dialogue, sound effects, background music, and transcription. Use when the user asks for a voiceover, narration, an AI voice, podcast or audiobook audio, a sound effect, background music, or a transcript of an audio or video file.
---

# ElevenLabs HTTP API

Audio generation and transcription via ElevenLabs' REST API. All calls go through Duet's service proxy, which injects the upstream credential — you only need the system-managed `$DUET_API_KEY`.

```bash
DUET_PROXY="$DUET_API_URL/v1/services/elevenlabs"
# Auth header for every call:
#   -H "Authorization: Bearer $DUET_API_KEY"
```

Never send an `xi-api-key` header — the proxy strips it and injects its own.

The `duet model` CLI (media-creation skill) owns image and video generation and has no audio role. Every audio request goes here, including the voiceover on a video that `duet model` produced.

## Workflow

| Need                              | Endpoint                              | Notes                                     |
| --------------------------------- | ------------------------------------- | ----------------------------------------- |
| Voiceover, narration, spoken text | `POST /v1/text-to-speech/{voice_id}`  | Pick the voice first                       |
| Two or more speakers in one take  | `POST /v1/text-to-dialogue`           | One voice per line                         |
| Sound effect, foley, ambience     | `POST /v1/sound-generation`           | 0.5–30s, can loop                          |
| Background music track            | `POST /v1/music`                      | Length in milliseconds                     |
| Transcript from audio or video    | `POST /v1/speech-to-text`             | See `reference/speech-to-text.md`          |
| Curated shared voice library      | `GET /v1/shared-voices`               | Vendor-provided reusable voices           |

Speech, transcription, and sound effects are billed at what ElevenLabs charges for them, so cost follows the length of the text and audio. Job polls and model discovery are free. Reuse a transcript you already have rather than transcribing the same media twice.

Account, usage, history, and voice-agent endpoints are not available through the proxy.

## Generated audio is bytes, not JSON

The generation endpoints return a raw audio stream. Write it straight to a file with `-o` — never pipe one to `jq`, and never read the file back into context.

Errors arrive as JSON with a 4xx status *in that same file*, so capture the status code and only inspect the body when the call failed:

```bash
CODE=$(curl -s -w '%{http_code}' -o voiceover.mp3 \
  -X POST "$DUET_PROXY/v1/text-to-speech/$VOICE_ID" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Welcome to the show.", "model_id": "eleven_multilingual_v2"}')
[ "$CODE" = 200 ] || cat voiceover.mp3
```

Audio previews inline in Duet, so write deliverables into the user's working folder where they can play them — not into a dot-directory.

## Use a voice

Pass a voice ID the user already has, one from the curated shared voice
library, or one returned by a voice-creation call. The proxy does not expose
the vendor account voice list, so it will not enumerate Duet-created voice IDs.
A saved voice ID remains usable in text-to-speech and can be read, edited, or
deleted through its ID subject to workspace ownership.

Reuse one `voice_id` across every line of a project. Switching voices mid-deliverable is the most common way narration comes out inconsistent.

## Shared voice pool

Duet tracks created voices in a shared pool. Everyone can use a saved voice ID, while only the creating workspace can mutate or delete it. A workspace may create a voice with one of these routes:

- `POST /v1/voices/add` — upload an instant-clone source
- `POST /v1/voices/add/{public_user_id}/{voice_id}` — add a public library voice
- `POST /v1/text-to-voice` — design a voice from a prompt

Pass the design prompt in the vendor's description field when creating a voice.
The service proxy adds the vendor metadata label `labels.designPrompt`, which
records the submitted voice-design description for later identification, and
`labels.createdVia: duet` on creation routes that accept labels. These labels
do not change the generation prompt; do not add or spoof them in the request.
Created voices are temporary and expire after 24 hours. Only the
workspace that created a tracked voice may edit it with
`POST /v1/voices/{voice_id}/edit` or delete it with
`DELETE /v1/voices/{voice_id}`. Curated and pre-existing voices remain
read-only through the proxy.

## Models

`GET /v1/models` is the authority on what audio models are available and what each supports. Current speech defaults:

- `eleven_v3` — most expressive, best for character and emotional delivery
- `eleven_multilingual_v2` — reliable general-purpose narration, broad language coverage
- `eleven_flash_v2_5` — lowest latency, for interactive or long batch runs

Sound effects use `eleven_text_to_sound_v2`, music uses `music_v1`, transcription uses `scribe_v1`.

## Endpoints

Full upstream docs: <https://elevenlabs.io/docs>.

### text to speech

```bash
curl -s -X POST "$DUET_PROXY/v1/text-to-speech/$VOICE_ID?output_format=mp3_44100_128" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "The full paragraph, punctuation and all.",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
  }' -o narration.mp3
```

Body: `text` (required), `model_id`, `language_code`, `voice_settings`, `seed`, `previous_text`/`next_text`, `apply_text_normalization`.

`output_format` is a query parameter named `codec_sample_rate_bitrate`, defaulting to `mp3_44100_128`. Use `mp3_44100_192` for publishable audio and a `pcm_*` or `wav_*` format when the file feeds further editing. The top bitrates and the 44.1kHz PCM/WAV formats are gated behind higher ElevenLabs plans, so a call that fails only when you raise the format is a plan limit, not a broken key — fall back to the default rather than retrying.

Splitting a script across calls loses prosody at the seams. When you must split, pass the neighbouring text as `previous_text` and `next_text` so the model keeps its rhythm.

### text to dialogue

One request, one voice per line, natural turn-taking between them.

```bash
curl -s -X POST "$DUET_PROXY/v1/text-to-dialogue" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": [
      {"text": "So what changed this quarter?", "voice_id": "<host-voice>"},
      {"text": "Everything, honestly.", "voice_id": "<guest-voice>"}
    ],
    "model_id": "eleven_v3"
  }' -o interview.mp3
```

### sound effects

```bash
curl -s -X POST "$DUET_PROXY/v1/sound-generation" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "heavy wooden door closing in a stone hallway, tail reverb",
    "duration_seconds": 4,
    "prompt_influence": 0.5
  }' -o door.mp3
```

Body: `text` (required), `duration_seconds`, `loop`, `prompt_influence`, `model_id`. Set `loop: true` for ambience that has to tile seamlessly under a longer cut.

### music

```bash
curl -s -X POST "$DUET_PROXY/v1/music" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "understated ambient synth bed, warm, no drums, product demo underscore",
    "music_length_ms": 30000,
    "model_id": "music_v1",
    "force_instrumental": true
  }' -o bed.mp3
```

Body: `prompt`, `music_length_ms`, `model_id`, `force_instrumental`, `lyrics_text`, `seed`. Set `force_instrumental` for anything playing under a voiceover — the model adds vocals otherwise.

## References

- [reference/speech-to-text.md](reference/speech-to-text.md) — transcription, diarization, word timestamps, subtitle formats
