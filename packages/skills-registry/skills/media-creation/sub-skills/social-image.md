# Social Image

Generate images for social media feeds and stories. Defaults to square (1:1) when no format is specified.

**GPT Image 2.5 Flare is the default for everything** — including text-heavy squares, quote cards, and headline-led graphics. It renders text accurately. Generate with the `duet model` CLI — no scripts. See [../reference/text-to-image.md](../reference/text-to-image.md) for full CLI patterns.

After generating, **tell the user which model you used and offer alternatives** in one line — e.g., _"Generated with GPT Image 2.5 Flare. If you want a different look, I can also try Nano Banana 2 or Seedream / Imagen."_

**Platform clarification:** If the user asks for a "social media image" without specifying a platform, ask which platform(s) they're targeting — the optimal format differs significantly (square for general use, portrait for Instagram/Facebook feed, vertical for Stories). If context makes it obvious (e.g., "Instagram story"), just proceed. Default to square (1:1) when no clarification is possible.

---

## Square — Default Social Image

The universal safe choice. Works on every platform without cropping.

| Setting      | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| Aspect ratio | 1:1                                                            |
| Resolution   | 1024 x 1024 px                                                 |
| Use cases    | Instagram feed, LinkedIn, Twitter/X, Facebook, general-purpose |

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1024 -o output.png "<PROMPT>"
```

For text-heavy squares (quote cards, stat graphics), still use GPT Image 2.5 Flare — put the exact text in `"quotation marks"` inside the prompt and ask for "crisp, high-detail typography" (the CLI has no `quality` flag).

**Composition guidance:**

- Center the subject — square crops are unforgiving to off-center compositions
- Use bold, high-contrast elements; images display small in feeds (~470px on mobile)
- Keep text to under 20% of the image area for best ad delivery
- If including text, use maximum 5-8 words in the headline

---

## Portrait — Instagram / Facebook / LinkedIn Feed

Maximum feed real estate on mobile. Best engagement format for feed posts.

| Setting      | Value                                        |
| ------------ | -------------------------------------------- |
| Aspect ratio | 4:5                                          |
| Resolution   | 1024 x 1280 px                               |
| Use cases    | Instagram feed, Facebook feed, LinkedIn feed |

GPT Image 2.5 Flare takes custom sizes, so ask for 4:5 directly:

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1280 -o output.png "<PROMPT>"
```

**Composition guidance:**

- Place the primary subject in the upper 60% of the frame — feeds sometimes truncate the bottom
- This format takes up ~20% more screen space than square in Instagram feeds
- Design for the center crop: Instagram grid previews at 3:4, so key content must survive a slight vertical trim

---

## Story — Instagram / TikTok / Snapchat

Full-screen vertical image for Stories and similar ephemeral formats.

| Setting      | Value                                          |
| ------------ | ---------------------------------------------- |
| Aspect ratio | 9:16                                           |
| Resolution   | 1080 x 1920 px                                 |
| Use cases    | Instagram Stories, TikTok photo mode, Snapchat |

**Safe zones (1080x1920 canvas):**

- Top 250px: obscured by profile name, time indicator
- Bottom 250px: obscured by reply bar, swipe-up/link area
- Usable safe area: 1080 x 1420 px centered

GPT Image 2.5 Flare takes custom sizes, so ask for 9:16 directly:

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1152x2048 -o output.png \
  "<PROMPT>. Keep key content in the vertical center of the frame — avoid the top and bottom edges."
```

**Composition guidance:**

- Keep key content (text, faces, products) in the vertical center of the frame
- Design for full-bleed — the image fills the entire screen, so backgrounds matter
- Use bold, large text — Stories are viewed quickly and on small screens

---

## Reference

- [Text to Image CLI patterns](../reference/text-to-image.md) — `duet model` flags, GPT Image 2.5 Flare/NB2 commands, editing, multi-image composition
- [Prompt engineering & platform specs](../reference/prompt-engineering.md) — image prompt tips, brand integration, text-in-images checklist, platform dimensions
