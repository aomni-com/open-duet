# Prompt Engineering & Platform Specs

Shared prompt engineering guidance and platform specifications for all media creation use cases.

## Video Prompt Structure (5-Component Formula)

For the best results, structure video prompts with these five components:

1. **Subject & action**: What is happening and to whom — "A woman in a red dress walks through a rain-soaked Tokyo alley"
2. **Setting & environment**: Where it takes place — "neon signs reflect off wet cobblestones, steam rises from a street vendor's cart"
3. **Camera work**: How it's filmed — "steadicam tracking shot at eye level, moving with the subject"
4. **Lighting & atmosphere**: The mood — "warm neon glow mixed with cool blue ambient light, cinematic color grading"
5. **Style & aesthetic**: The visual feel — "shot on 35mm film, shallow depth of field, Blade Runner atmosphere"

Optimal prompt length is 100-200 words (3-6 sentences). Focus each prompt on a single, focused moment — don't chain multiple events into one clip.

## Camera Language Cheat Sheet

| Term                  | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `tracking shot`       | Camera follows the subject's movement                      |
| `dolly in/out`        | Camera moves toward/away from subject on a track           |
| `crane shot`          | Camera sweeps up or down from an elevated position         |
| `steadicam`           | Smooth handheld-style movement                             |
| `slow pan left/right` | Camera rotates horizontally                                |
| `tilt up/down`        | Camera rotates vertically                                  |
| `zoom in/out`         | Focal length change (different from dolly)                 |
| `aerial/drone shot`   | Camera high above, looking down                            |
| `Dutch angle`         | Camera tilted off-axis for tension                         |
| `rack focus`          | Focus shifts from foreground to background (or vice versa) |
| `locked-off / static` | Camera doesn't move — subject does all the work            |

## Negative Prompt Defaults

The `duet model` CLI has no `negativePrompt` flag, so fold these exclusions directly into the prompt text (e.g. "avoid: watermark, text overlay, blurry, low resolution"):

```
watermark, text overlay, logo, blurry, out of focus, low resolution, noisy, glitch, artifacts, distortion, overexposed, underexposed, lens flare
```

## Video Role Selection Guide

Start text-to-video and image-to-video work with the `video` role. When the
request needs a specialized tradeoff, compare the current `video:*` entries in
`models.json` by description and pricing. Treat that generated reference as the
authority: provider assignments, access policy, and the model behind a role may
change without this guide changing. See [text-to-video.md](text-to-video.md) and
[image-to-video.md](image-to-video.md) for CLI patterns.

## Image Prompt Tips

### General (GPT Image 2.5 Flare — Default)

- **Describe scenes, don't list keywords.** A narrative paragraph beats a comma-separated tag list.
- **Use positive framing.** Say "empty street" not "no cars." Describe what you want, not what to avoid.
- **Control size with the `--size` flag**, not prompt text: `1024x1024` (square), `1536x1024` (landscape), `1024x1536` (portrait), or `auto`. Custom `WIDTHxHEIGHT` sizes (edges multiples of 16, aspect ratio 1:3–3:1) such as `1024x1280` (4:5) or `1536x864` (16:9) also work — see [text-to-image.md](text-to-image.md).
- **Use photographic terms** for composition control: `wide-angle shot`, `85mm portrait lens`, `macro close-up`, `golden-hour lighting`, `studio lighting`.
- **The CLI has no `quality` flag** — request high detail in the prompt itself (e.g. "high-detail studio product photography") for product photos and hero imagery where detail matters.

### Nano Banana 2 (Single-Image Editing / User Request)

Only use NB2 when (a) the user asks for single-image editing (GPT Image 2.5 Flare's edit endpoint isn't exposed through the AI Gateway today) or (b) the user explicitly asks for NB2.

- **Describe scenes, don't list keywords.** A narrative paragraph beats a comma-separated tag list.
- **Be explicit about wanting an image.** Say "create an image of" or "generate an image" — otherwise the model may respond with text.
- **Control aspect ratio and resolution via prompt:** NB2 takes no `--size` flag, so include "Square 1:1 format" or "Vertical 9:16, 1080x1920" in the prompt text.
- **For single-image editing** — pass the source image as multimodal input alongside your edit instruction.

### Color and Brand Integration

When generating branded content, include colors explicitly:

```
Professional social media graphic featuring the brand colors #1E40AF (deep blue) and #F59E0B (amber).
Modern minimalist style with clean typography. The primary color should dominate the background
while the accent color highlights key data points.
```

### Text in Images Checklist

- [ ] Keep headline text to 5-8 words maximum
- [ ] Put exact text in quotation marks in the prompt
- [ ] Use GPT Image 2.5 Flare — it renders text accurately for headlines, infographics, posters
- [ ] Specify font style: "bold sans-serif", "modern display font", "clean professional typography"
- [ ] Request high contrast between text and background

## Platform Quick Reference

### Video Specs at a Glance

| Platform          | Aspect Ratio | Resolution             | Duration (AI clip) | Safe Zone Notes                   |
| ----------------- | ------------ | ---------------------- | ------------------ | --------------------------------- |
| TikTok            | 9:16         | 1080x1920              | 5-8s               | Bottom 370px, right 180px blocked |
| Instagram Reels   | 9:16         | 1080x1920              | 5-8s               | Bottom 320px, right 120px blocked |
| YouTube Shorts    | 9:16         | 1080x1920              | 5-8s               | Top/bottom 380px each blocked     |
| LinkedIn          | 1:1 or 16:9  | 1080x1080 or 1920x1080 | 5-8s               | Minimal overlay                   |
| Twitter/X         | 16:9 or 1:1  | 1280x720 or 1080x1080  | 5-8s               | Minimal overlay                   |
| Instagram Stories | 9:16         | 1080x1920              | 5-8s               | Top/bottom 250px blocked          |
| Promo / Web       | 16:9         | 1920x1080              | 5-8s               | No overlay                        |

### Image Specs at a Glance

| Platform          | Best Format        | Dimensions                 | Aspect Ratio |
| ----------------- | ------------------ | -------------------------- | ------------ |
| Instagram feed    | Portrait           | 1080 x 1350                | 4:5          |
| Instagram Stories | Full vertical      | 1080 x 1920                | 9:16         |
| LinkedIn          | Square or portrait | 1200 x 1200 or 1200 x 1500 | 1:1 or 4:5   |
| Twitter/X         | Landscape          | 1600 x 900                 | 16:9         |
| Facebook          | Portrait           | 1080 x 1350                | 4:5          |
| OG / Link preview | Landscape          | 1200 x 630                 | 1.91:1       |
| Infographic       | Portrait           | 1080 x 1350                | 4:5          |
| Product photo     | Square             | 1024 x 1024                | 1:1          |
