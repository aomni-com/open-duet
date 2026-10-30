# Text to Image — CLI Reference

Generate or edit images from text prompts with the **`duet model`** CLI. Default model is GPT Image 2.5 Flare — use it for everything unless the user requests otherwise or you hit a capability exception. No code, no SDK install: the CLI calls the gateway directly using `DUET_API_KEY` and prints the path of each file it writes.

```bash
duet model -m <MODEL> [--type image] [--image <src>] [-o out.png] [--size WxH] "<prompt>"
```

Throughout this reference, `<MODEL>` is the **gateway model id** for the role
named above each command. Resolve it from `models.json` in this directory — the
CLI takes gateway ids, not role ids:

```bash
jq -r '.models[] | select(.id == "image") | .gatewayModelId' models.json
```

## Relevant Flags

| Flag             | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `-m, --model`    | Exact gateway model ID (optional with `--type image`)                  |
| `--type image`   | Force image output (needed for multimodal LLMs like NB2; optional for GPT Image) |
| `--image <path>` | One input image for editing; repeated flags replace the source        |
| `-o, --out`      | Output path (auto-named when omitted)                                            |
| `--size <WxH>`   | Image size, e.g. `1024x1024`                                                     |
| `--background`   | `transparent`, `opaque`, or `auto` — OpenAI image models only (`duet` 0.3.20+)   |
| `--n <count>`    | Number of outputs                                                                |
| `--seed <int>`   | Generation seed (where the model supports it)                                    |

> **One `providerOptions` field, `--background`.** The CLI exposes no other per-model `providerOptions` (`quality`, etc.). Drive those qualities through the prompt text. If you genuinely need another `providerOptions` field, fall back to the [ai-gateway skill](../../ai-gateway/SKILL.md).

## GPT Image 2.5 Flare (Default — Use for Everything)

OpenAI's fast everyday image model — higher quality than GPT Image 2 at about half the latency. Handles general-purpose imagery, text-heavy graphics (infographics, posters, headlines), product shots, and branded content.

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1024 -o output.png "<PROMPT>"
```

### GPT Image 2.5 Flare Sizes & Notes

- Supported `--size`: the fixed `1024x1024`, `1536x1024`, `1024x1536`, `auto`, or any custom `WIDTHxHEIGHT` with both edges multiples of 16 and an aspect ratio between 1:3 and 3:1 — e.g. `1024x1280` (4:5), `1536x864` (16:9), `1152x2048` (9:16). Custom sizes come back pixel-exact through the gateway.
- Does NOT support aspect-ratio flags — use `--size`.
- Does NOT support `--seed`.
- Transparent backgrounds: pass `--background transparent` (below). Asking for transparency in the prompt alone returns an opaque PNG.

### High Quality

The CLI has no `quality` flag. For hero images, product photography, or detail-critical visuals, request high quality in the prompt itself:

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1024 -o headphones.png \
  "High-detail studio product photograph of wireless headphones, soft shadows, crisp focus, premium catalog quality"
```

### Text-in-Image Tips

GPT Image 2.5 Flare renders text accurately — you don't need another model for headlines, infographics, or typography-heavy designs. For best results:

- Put the exact text in the prompt, ideally in `"quotation marks"`.
- Keep headlines short (5–8 words).
- Specify a font style explicitly: "bold sans-serif", "modern display font", "clean professional typography".
- Specify high contrast between text and background.

### Transparent Backgrounds

Pass `--background transparent` — it sets OpenAI's `background` option and returns a true RGBA PNG (verified: the alpha channel is populated). Prompt wording alone ("transparent background") does not; the model paints a backdrop instead. Needs `duet` 0.3.20 or newer; older CLIs reject the flag.

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --background transparent --size 1024x1024 -o logo.png \
  "A single red maple leaf, isolated subject, no scenery"
```

## Single-Image Editing (Nano Banana 2)

The gateway exposes GPT Image 2.5 Flare as text-in only, so its edits endpoint is not reachable from `duet model`. The working path for editing a single image is Nano Banana 2 — a multimodal LLM. Because NB2 is catalog-inferred as a text model, you **must** pass `--type image` to get an image back, and supply the source with `--image`.

```bash
# <MODEL>: gatewayModelId for role "image:google"
duet model -m <MODEL> --type image \
  --image input.png -o output.png "Change the background to a beach sunset"
```

## Multi-Image Composition (Nano Banana 2)

The current CLI accepts one source image. For multiple image inputs, use a
language model that supports them through the AI SDK, following the
[ai-gateway skill](../../ai-gateway/SKILL.md). Repeating `--image` replaces the
previous source rather than composing the inputs.

## Nano Banana 2 (Direct Text-to-Image — Only When User Requests)

NB2 (`image:google`) is also available for plain text-to-image — use it only when the user explicitly asks for it, or when GPT Image 2.5 Flare's output is unsatisfactory and you want to offer a different look. It does not accept a `--size` flag; control aspect ratio and resolution through the prompt text.

```bash
# <MODEL>: gatewayModelId for role "image:google"
duet model -m <MODEL> --type image -o output.png \
  "<PROMPT>. Vertical 9:16 format, 1080x1920."
```

Supported aspect ratios (14 total): `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `1:4`, `4:1`, `1:8`, `8:1`. For multiple variations, ask for them in the prompt (e.g. "Generate 4 variations …") or pass `--n`.

## Delivering Results

The CLI prints each output path. Upload via the Duet Files API and send as a message part, or provide the file path to the user.

## Model Discovery

Discovery includes upstream media outside Duet’s local catalog. Omitting the
model with `--type image` uses the existing image default. Exact IDs override
that choice; a language model emitting images still needs the explicit output
type. Native image generation uses the $2 hold and actual-cost settlement.


```bash
curl -fsS "$DUET_GATEWAY_BASE_URL/v1/models" \
  -H "Authorization: Bearer $DUET_API_KEY"
```

## Error Handling

| Error / Symptom                        | Cause                             | Fix                                                                     |
| -------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `Unknown model` / not-found            | Invalid model ID                  | Check the model ID against the model-discovery list                     |
| Upstream unsupported-model error      | Wrong model ID or operation       | Inspect discovery metadata and use an exact gateway ID; roles resolve through `models.json` |
| `401 Unauthorized`                     | Bad or missing API key            | Verify the system-managed `DUET_API_KEY` is present                     |
| Got text instead of an image (no file) | NB2 inferred as a text model      | Add `--type image` to force image output                                |
| Transparent background ignored         | Transparency asked for in the prompt only | Pass `--background transparent` (`duet` 0.3.20+)                  |
| Empty or low-quality image             | Prompt too vague                  | Be more specific about subject, style, lighting, and composition        |
