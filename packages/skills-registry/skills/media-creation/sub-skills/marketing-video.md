# Marketing Video

Generate video clips for marketing, ads, and professional social feeds. Covers widescreen promo and square feed formats.

Generate with the `duet model` CLI and the default `video` role, passing that role's `gatewayModelId` from `models.json`. If quality is insufficient, escalate to `video:seedance`, or choose another `video:*` role from `models.json`. Video takes a few minutes; allow a generous timeout. See [../reference/text-to-video.md](../reference/text-to-video.md) for full role-selection guidance.

**Platform clarification:** If the user asks for a "promo video" or "marketing video" without specifying where it will be used, ask whether it's for widescreen (website, YouTube, ads) or square (LinkedIn, Twitter feed). The aspect ratio and composition strategy differ significantly. If context makes it obvious, just proceed.

---

## Promo Landscape — Ads / Website Hero / YouTube

Standard widescreen format for ads, website hero videos, presentations, and YouTube.

| Setting      | Value                                                      |
| ------------ | ---------------------------------------------------------- |
| Aspect ratio | 16:9                                                       |
| Resolution   | 1080p                                                      |
| Duration     | 5-8 seconds                                                |
| Use cases    | Website hero, YouTube pre-roll, ad creative, presentations |

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --aspect 16:9 --duration 8 --resolution 1920x1080 -o output.mp4 "<PROMPT>"
```

**Composition guidance:**

- Use cinematic language: "widescreen shot", "slow dolly forward", "golden hour lighting", "shallow depth of field"
- Use the 5-component prompt structure: **Subject & action**, **Setting & environment**, **Camera work**, **Lighting & atmosphere**, **Style & aesthetic** (see [prompt engineering reference](../reference/prompt-engineering.md))
- Optimal prompt length is 100-200 words (3-6 sentences)
- Focus each prompt on a single, focused moment — don't chain multiple events into one clip
- Fold exclusions into the prompt (the CLI has no `negativePrompt` flag): "avoid watermark, text overlay, blurry, low quality, shaky camera"
- For marketing: open with the product/result, not a slow build

---

## Social Square — LinkedIn / Twitter / Feed

Square video for maximum compatibility across platforms without cropping.

| Setting      | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| Aspect ratio | 1:1                                                          |
| Resolution   | 720p                                                         |
| Duration     | 5-8 seconds                                                  |
| Use cases    | LinkedIn feed, Twitter/X feed, Facebook feed, Instagram feed |

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --aspect 1:1 --duration 8 -o output.mp4 "<PROMPT>"
```

**Composition guidance:**

- Square is the safest cross-platform format — no cropping on any feed
- Center all action — there's no "widescreen" space to work with
- LinkedIn audiences respond to professional, clean aesthetics: "modern office", "clean workspace", "professional setting"
- Keep it simple: one subject, one action, one message per clip

---

## Reference

- [Text to Video CLI patterns](../reference/text-to-video.md) — `duet model` flags, role selection, errors
- [Prompt engineering & platform specs](../reference/prompt-engineering.md) — 5-component formula, camera cheat sheet, negative prompts, platform dimensions
