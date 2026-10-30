# App Icons

Every non-headless app must have a custom icon. If `headless` is `true`, an icon is optional. Use AI image generation (e.g. GPT Image 2.5 Flare) to create a visually distinct icon for each non-headless app.

## Requirements

- **Square, 1024x1024 px, PNG format**
- **Vibrant, high-contrast background** -- use a bold, saturated gradient (e.g. coral/purple/pink, teal/blue/indigo) so the icon pops in both light and dark mode sidebars
- **No rounded corners, borders, or frames** -- the Duet sidebar automatically crops and rounds the icon. The image itself should be full-bleed, edge-to-edge
- **No text** -- the app name is displayed separately in the sidebar
- **Distinct visual metaphor** -- the icon should clearly represent what the app does (e.g. bar chart for analytics, magnifying glass for search, envelope for email)
- **High contrast between foreground and background** -- use bold white or light-colored 3D elements against the colorful gradient for maximum readability at small sizes

## Example Prompt for AI Image Generation

```
Square illustration, no border, no rounded corners, no frame, no outline.
Bright vivid gradient background with saturated [color 1], [color 2],
and [color 3] flowing together. [Visual metaphor for the app] made of
solid glossy white 3D material with strong shadows and highlights,
dramatic lighting from above left. High contrast, bold, eye-catching.
The design fills the entire canvas edge-to-edge with no padding. No text.
```

## Saving the Icon

Invoke the `media-creation` skill and run `duet model` with the prompt
above, replacing its bracketed descriptions with an app-specific palette and
metaphor. Generate a 1024x1024 PNG, save it as `icon.png` inside the app's
project folder, and set `icon` to `icon.png` in the app payload. The final file
must be no larger than 1 MB; simplify or optimize it before registration when
it exceeds that limit.

## Refreshing Icons

When icon bytes change without a filename change, inspect the existing app and
PATCH its `icon` field with the same filename. The update advances the cache
version even though the field value is unchanged.

```bash
APP_SLUG=analytics
curl -sS -X PATCH "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps/$APP_SLUG" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"icon":"icon.png"}'
```
