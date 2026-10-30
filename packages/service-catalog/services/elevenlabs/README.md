# ElevenLabs

ElevenLabs supplies speech, dialogue, sound effects, music, transcription, and
voice tools through the catalog. The vendor's curated shared voice library is
available; the account voice-list route is intentionally absent because it would
enumerate Duet-created ids. Clients use a voice id they already have, one from
the curated library, or one returned by creation. Created voices are tracked
per workspace, expire after 24 hours, and can be reused by saved id; only the
creating workspace may edit or delete a tracked voice.

The provider hook adds the vendor label `labels.designPrompt` from the submitted
voice-design description. It is searchable metadata describing the prompt that
created the voice; it is not a second prompt sent to the model and does not
change synthesis. The hook also forces `labels.createdVia` to `duet` on creation
routes that accept labels. Agents pass the description; they do not own either
proxy-owned marker.

Vault source: `ELEVENLABS_API_KEY`.

Official documentation reviewed 2026-10-13: [ElevenLabs API docs](https://elevenlabs.io/docs).
