# Image Animation

Animate a still image into a video clip. Covers subtle motion (bringing photos to life) and dynamic promo animation (product launches, teasers).

Generate with the `duet model` CLI and the default `video` role, passing that role's `gatewayModelId` from `models.json`. Pass the still with `--image` and describe the motion in the prompt. If quality is insufficient, escalate to `video:seedance`, or choose another `video:*` role from `models.json`. Video takes a few minutes; allow a generous timeout. See [../reference/image-to-video.md](../reference/image-to-video.md) for full role-selection guidance.

**Platform clarification:** If the user wants a promo animation for social media, ask which platform(s) they're targeting — vertical (9:16) for TikTok/Reels/Shorts vs. widescreen (16:9) for web/ads. For subtle animations (bringing a photo to life), the source image's aspect ratio is typically preserved, so no clarification is needed.

---

## Subtle Animation — Bring a Still to Life

Add natural, gentle motion to a static image while preserving the original composition.

| Setting      | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Aspect ratio | Match the source image (auto-detected)                                             |
| Duration     | 5-8 seconds                                                                        |
| Use cases    | Animate product photos, bring illustrations to life, add motion to social graphics |

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --image still.png --duration 5 -o output.mp4 "<ANIMATION_PROMPT>"
```

The aspect ratio is taken from the source image by default.

**Composition guidance:**

- Describe the motion, not the scene (the model already sees the image): "gentle camera push-in with leaves rustling in the breeze" not "a forest scene with trees"
- Start with subtle motion: "slow pan", "gentle zoom", "soft parallax", "hair and clothes move in a light breeze"
- Avoid asking for dramatic scene changes — the model works best when extending what's already in the frame
- For product shots: "slow 360-degree rotation", "subtle floating motion with soft shadow movement"
- For portraits: "gentle head turn, natural blink, soft ambient motion in background"

---

## Promo Animation — Product / Marketing from Still

Turn a product photo or marketing image into a short promo clip with dynamic camera work.

| Setting      | Value                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| Aspect ratio | 9:16 (for social) or 16:9 (for web/ads)                                   |
| Duration     | 5-8 seconds                                                               |
| Use cases    | Product launches, ad creative, social media teasers from existing imagery |

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --image product.png --aspect 9:16 --duration 8 -o output.mp4 "<PROMO_PROMPT>"
```

Use `--aspect 16:9` for landscape instead of `9:16`.

**Composition guidance:**

- Describe energetic but controlled camera work: "dynamic orbit around the product", "dramatic zoom-in revealing details", "sweeping crane shot pulling back to reveal the full product"
- Add environmental motion: "particles floating in the air", "light refractions moving across the surface", "subtle smoke or mist in the background"
- For text-heavy source images (posters, ads): "text elements animate in sequentially, background comes to life with subtle motion"
- End with the product centered and stable — gives a clean final frame for the promo

---

## Reference

- [Image to Video CLI patterns](../reference/image-to-video.md) — `duet model` flags, role selection, errors
- [Prompt engineering & platform specs](../reference/prompt-engineering.md) — camera cheat sheet, negative prompts, platform dimensions
