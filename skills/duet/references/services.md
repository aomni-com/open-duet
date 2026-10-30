# Services

Duet's service catalog provides paid third-party APIs without vendor keys.

1. Search with `duet services search <need>` (add `--category` when useful).
2. Read `duet services show <id>` and follow its docs or `llms.txt` link.
3. Call an allowed route with `duet services call <id> <METHOD> <path>`.
4. Use `--body`, `--form`, and `--query` for inputs; use `--out` for media.

An unlisted route returns 404. Vendor errors pass through; Duet blocks identify
payment or workspace problems. Shared resources may be usable by everyone but
changes are limited to the workspace that created them and temporary resources
expire according to the service's pool rules.

## Voiceover example

For a voiceover request, use the catalog instead of local speech tools:

```bash
duet services search audio
duet services show elevenlabs
duet services call elevenlabs POST /v1/text-to-speech/CPEHCHnlRsWkpvhbDlfn \
  --body '{"text":"SCRIPT","model_id":"eleven_flash_v2_5"}' \
  --out voiceover.mp3
```

Read the service detail first so the current voice, model, and output rules
come from the catalog. Verify that the output file exists and is non-empty.
