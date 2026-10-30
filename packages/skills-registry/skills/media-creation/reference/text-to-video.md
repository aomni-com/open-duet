# Text to Video — CLI Reference

Generate video clips from text prompts with the **`duet model`** CLI. Start with the stable `video` role, and pass that role's `gatewayModelId` from `models.json` — the CLI takes gateway ids, not role ids. No code or SDK: the CLI calls the gateway, writes the `.mp4`, and prints its path. Video generation takes a few minutes — allow a generous timeout.

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video --aspect 16:9 --duration 8 -o output.mp4 "<SCENE_DESCRIPTION>"
```

## Relevant Flags

| Flag                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `-m, --model`          | Gateway model id for the role you chose             |
| `--type video`         | Force video output (optional when the catalog already infers video) |
| `--aspect <W:H>`       | Aspect ratio, e.g. `16:9`, `9:16`, `1:1`                            |
| `--duration <seconds>` | Clip length (typically 4–8)                                         |
| `--resolution <WxH>`   | e.g. `1920x1080`                                                    |
| `--fps <int>`          | Frames per second                                                   |
| `-o, --out`            | Output path (auto-named when omitted)                               |

> **No `providerOptions`.** The CLI has no `negativePrompt` flag — fold exclusions into the prompt text (e.g. "no watermark, no text overlay, no shaky camera").

## Generating a Video

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --aspect 16:9 --duration 8 -o output.mp4 "<SCENE_DESCRIPTION>"
```

The CLI prints the output path. Upload via the Duet Files API and send as a message, or provide the file path to the user.

## Model Selection

Start with `video`, the default. Escalate to `video:seedance` when the default
is not good enough, and use another `video:*` role only when its current
description in `models.json` matches a requested capability or style. This role
contract is the default; provider product names are not.

### Escalating past the default

When the default is not good enough, `video:seedance` is the higher-fidelity
run of the same family:

```bash
# <MODEL>: gatewayModelId for role "video:seedance"
duet model -m <MODEL> --type video \
  --aspect 9:16 --duration 8 -o output.mp4 "<SCENE_DESCRIPTION>"
```

## Quality Checklist

- [ ] Prompt describes motion, action, and camera movement — not just a static scene
- [ ] Video written successfully (check the printed path; file size > 0)
- [ ] Output delivered to user
- [ ] If quality is insufficient, re-read `models.json` and retry with a suitable `video:*` role

## Error Handling

| Error / Symptom             | Cause                  | Fix                                                      |
| --------------------------- | ---------------------- | -------------------------------------------------------- |
| `Unknown model` / not-found | Invalid model ID       | Check the model ID against the model-discovery list      |
| `403 tier_not_allowed`      | Passed a role id instead of a gateway model id | Resolve the role through `models.json` and pass its `gatewayModelId` |
| `401 Unauthorized`          | Bad or missing API key | Verify the system-managed `DUET_API_KEY` is present      |
| Command seems to hang       | Normal for video       | Generation can take several minutes — extend the timeout |
| Low-quality output          | Prompt too vague       | Be specific about camera movement and subject actions    |
| Low-quality output          | Model choice           | Choose another `video:*` role from `models.json`          |
