# Marketing Image

Generate images for marketing use cases: widescreen/OG graphics, infographics, and product photography.

All images are generated with the `duet model` CLI — no scripts. **GPT Image 2.5 Flare is the default for everything** — including infographics and text-heavy graphics. Transparent backgrounds are the same model with `--background transparent`. See [../reference/text-to-image.md](../reference/text-to-image.md) for full CLI patterns.

After generating, **tell the user which model you used and offer alternatives** in one line — e.g., _"Generated with GPT Image 2.5 Flare — our best all-around model. If this isn't quite right, I can try Nano Banana 2 or Seedream / Imagen for a different look."_

---

## Landscape — Widescreen / Open Graph / Twitter

Standard landscape for link previews, blog headers, YouTube thumbnails, and Twitter/X posts.

| Setting      | Value                                                                                |
| ------------ | ------------------------------------------------------------------------------------ |
| Aspect ratio | 16:9 via `1536x864`, or 3:2 via `1536x1024`                                          |
| Resolution   | 1536 x 864 px or 1536 x 1024 px                                                      |
| Use cases    | Open Graph previews, Twitter/X feed, YouTube thumbnails, blog headers, presentations |

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1536x864 -o output.png "<PROMPT>"
```

**Composition guidance:**

- Place the primary subject left-of-center or at a rule-of-thirds intersection — leaves room for text overlays on the right
- Keep important content within the center 80% of the frame; OG image previews are cropped differently across platforms
- For OG/link previews: the ideal safe content area is approximately 1000 x 500 px centered within a 1200 x 630 image

---

## Infographic — Data Visualization / Stats

For stat-led graphics, data visualizations, comparison charts, and informational social posts.

**Use GPT Image 2.5 Flare** — it renders text accurately, handles headlines and stats, and uses the same `duet model` command as the rest of the marketing images.

| Setting      | Value                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Aspect ratio | 2:3 portrait via `1024x1536` (Instagram-leaning) or 1:1 (LinkedIn/Twitter) |
| Resolution   | 1024 x 1536 px or 1024 x 1024 px                                           |
| Use cases    | Social media infographics, stat-led branded graphics, comparison visuals   |

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1536 -o output.png \
  "<PROMPT>. Clean, high-detail typography."
```

**Composition guidance:**

- Put the exact headline text in the prompt inside `"quotation marks"` — GPT Image 2.5 Flare renders typed text accurately
- Keep headlines short (5–8 words)
- Specify brand colors by hex code: "color palette featuring #HEX1 and #HEX2"
- Include style keywords: "clean typography", "professional", "modern minimalist", "data visualization"
- Ask for "crisp, high-detail typography" in the prompt for sharp type rendering (the CLI has no `quality` flag)

---

## Product Photo — E-Commerce / Transparent Background

Clean product shots with optional transparent background.

For opaque product photos, use GPT Image 2.5 Flare and ask for high-detail studio quality in the prompt:

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --size 1024x1024 -o output.png \
  "<PROMPT>. High-detail studio product photography, soft shadows."
```

For transparent backgrounds, add `--background transparent` (`duet` 0.3.20+) — prompt wording alone returns an opaque PNG:

| Setting      | Value                                          |
| ------------ | ---------------------------------------------- |
| Aspect ratio | 1:1 or 4:5                                     |
| Resolution   | 1024 x 1024 px                                 |
| Use cases    | E-commerce, product marketing, catalog imagery |

The flag returns a true RGBA PNG:

```bash
# <MODEL>: gatewayModelId for role "image"
duet model -m <MODEL> --background transparent --size 1024x1024 -o output.png \
  "<PROMPT>, isolated subject, high-detail studio lighting"
```

**Composition guidance:**

- Ask for "high-detail studio" quality in the prompt for product images — detail matters (the CLI has no `quality` flag)
- Describe lighting explicitly: "studio lighting", "soft shadows", "product photography"
- For opaque backgrounds, omit `--background`

---

## Reference

- [Text to Image CLI patterns](../reference/text-to-image.md) — `duet model` flags, GPT Image 2.5 Flare/NB2 commands, editing, multi-image composition
- [Prompt engineering & platform specs](../reference/prompt-engineering.md) — image prompt tips, brand integration, text-in-images checklist, platform dimensions
