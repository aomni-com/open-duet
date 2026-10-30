# Short-Form Video

Generate vertical video clips for TikTok, Instagram Reels, and YouTube Shorts. Hook-first, designed for the scroll.

Generate with the `duet model` CLI and the default `video` role, passing that role's `gatewayModelId` from `models.json`. If quality is insufficient, escalate to `video:seedance`, or choose another `video:*` role from `models.json`. Video takes a few minutes; allow a generous timeout. See [../reference/text-to-video.md](../reference/text-to-video.md) for full role-selection guidance.

---

## Configuration

| Setting      | Value                                   |
| ------------ | --------------------------------------- |
| Aspect ratio | 9:16                                    |
| Resolution   | 720p (default) or 1080p                 |
| Duration     | 5-8 seconds (AI-generated clip)         |
| Use cases    | TikTok, Instagram Reels, YouTube Shorts |

```bash
# <MODEL>: gatewayModelId for role "video"
duet model -m <MODEL> --type video \
  --aspect 9:16 --duration 8 -o output.mp4 "<PROMPT_WITH_HOOK>"
```

---

## Safe Zones (1080x1920 canvas)

| Edge   | Margin | What's there                        |
| ------ | ------ | ----------------------------------- |
| Top    | 250px  | Profile info, status bar            |
| Bottom | 370px  | Captions, description, progress bar |
| Right  | 180px  | Like, comment, share, profile icons |
| Left   | 60px   | Minor padding                       |

Usable safe area: ~840 x 1300 px centered. **Never place key visuals in the bottom 20% or along the right edge.**

---

## Prompt Structure

Structure the prompt in three acts:

1. **Hook (0-2s):** Bold visual — the most compelling moment, result, or transformation
2. **Body (2-6s):** Show the process, the "how", or the contrast (old vs. new)
3. **Payoff (6-8s):** Result reveal, twist, or clean ending that loops back to frame 1

---

## Composition Best Practices

### The visual hook is everything

- The first 1-3 seconds determine whether viewers stop scrolling. 65% of viewers who watch the first 3 seconds will stay for 10+ seconds.
- **Open mid-action.** Never start with a static frame, a logo, or a "hello." Start with motion, a surprising visual, or a dramatic reveal already in progress.
- Describe the hook explicitly: "Opens with a close-up of [X] rapidly transforming into [Y]" or "First frame shows [dramatic result], then pulls back to reveal [context]."

### Design for silent viewing

- 85% of users watch without sound — the visual must carry the story on its own.
- If including text, keep it in the center safe zone away from platform overlays.

### Design for looping

- Connect the ending back to the beginning to encourage replays — this boosts algorithmic ranking on all three platforms.

### Camera and motion

- Use specific vertical camera language: "vertical tracking shot", "close-up pulling back to wide", "slow upward tilt"
- Keep all key action and text in the center safe zone. Faces, text, and products must avoid the bottom 370px and right 180px.

---

## Reference

- [Text to Video CLI patterns](../reference/text-to-video.md) — `duet model` flags, role selection, errors
- [Prompt engineering & platform specs](../reference/prompt-engineering.md) — 5-component formula, camera cheat sheet, negative prompts, platform dimensions
