# Image to Video — CLI Reference

Animate a still image into a video clip with the **`duet model`** CLI. Start with the stable `video` role, and pass that role's `gatewayModelId` from `models.json` — the CLI takes gateway ids, not role ids. Pass the still with `--image` and describe the motion in the prompt. No code or SDK: the CLI calls the gateway, writes the `.mp4`, and prints its path. Video generation takes a few minutes — allow a generous timeout.

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video --image still.png --duration 5 -o output.mp4 "<ANIMATION_DESCRIPTION>"
```

## Preparing the Image

`--image` accepts a local file path directly — no need to upload to a public URL first. JPG, PNG, and WebP all work.

## Generating the Video

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --image still.png --duration 5 -o output.mp4 "<ANIMATION_DESCRIPTION>"
```

The aspect ratio is taken from the source image by default. To override, add `--aspect 9:16` (or `16:9`, `1:1`). The CLI prints the output path. Upload via the Duet Files API and send as a message, or provide the file path to the user.

## Model Selection

Start with `video`. Use another `video:*` role only when its current
`models.json` description matches the requested capability.

### Using a specialized video role

```bash
# <MODEL>: gatewayModelId for role "video:pro"
duet model -m <MODEL> --type video \
  --image still.png --duration 5 -o output.mp4 "<ANIMATION_DESCRIPTION>"
```

## Quality Checklist

- [ ] Source image path is correct and readable
- [ ] Prompt describes motion and camera movement, not just the static scene
- [ ] Video written successfully (check the printed path; file size > 0)
- [ ] Output delivered to user
- [ ] If quality is insufficient, retry with a suitable role from `models.json`

## Error Handling

| Error / Symptom             | Cause                  | Fix                                                                            |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `Unknown model` / not-found | Invalid model ID       | Check the model ID against the model-discovery list                            |
| `403 tier_not_allowed`      | Passed a role id instead of a gateway model id | Resolve the role through `models.json` and pass its `gatewayModelId`   |
| `401 Unauthorized`          | Bad or missing API key | Verify the system-managed `DUET_API_KEY` is present                            |
| Command seems to hang       | Normal for video       | Generation can take several minutes — extend the timeout                       |
| Empty or corrupt video      | Prompt issue           | Simplify the prompt. Avoid contradictory or overly complex motion descriptions |
| Low-quality output          | Model choice           | Choose another `video:*` role from `models.json`                                |
