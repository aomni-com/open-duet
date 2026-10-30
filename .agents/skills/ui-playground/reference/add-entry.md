# Adding a playground entry — end-to-end

Concrete example: add a "callout banner" fixture under the `ui` group.

## 1. Create the component

```tsx
// apps/web/components/playground/callout-banner/callout-banner-playground.tsx
export function CalloutBannerPlayground() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Callout variant="info">Heads up — this is informational.</Callout>
      <Callout variant="warning">Careful — you're about to do a thing.</Callout>
      <Callout variant="error">Something broke.</Callout>
    </div>
  )
}
```

Rules:

- No Convex/Ably/sync-engine reads.
- No `Date.now()`, `Math.random()`, or wall-clock animations.
- No network images — inline SVG or data URLs only.
- Show every visual state you care about regressing on. One screenshot per entry; pack the variants into the fixture.

## 2. Register it

Two edits, both required — the `Record<PlaygroundId, ...>` constraint on `PLAYGROUND_RENDERERS` makes TypeScript fail compilation if either side is missing.

Metadata in `apps/web/app/playground/registry.ts`:

```ts
// inside PLAYGROUND_ENTRIES, under the appropriate group:
{ id: 'callout-banner', title: 'Callout banner', group: 'ui' },
```

Render thunk in `apps/web/app/playground/render-map.tsx`:

```tsx
import { CalloutBannerPlayground } from '@/components/playground/callout-banner/callout-banner-playground'

// inside PLAYGROUND_RENDERERS:
'callout-banner': () => <CalloutBannerPlayground />,
```

## 3. Generate the baseline

```bash
bun ui:approve -g "playground/callout-banner"
```

This runs Playwright with `--update-snapshots=all` scoped to your entry and writes:

- `apps/web/tests/visual/__screenshots__/desktop/tests/visual/playground.spec.ts/callout-banner.png`
- `apps/web/tests/visual/__screenshots__/mobile/tests/visual/playground.spec.ts/callout-banner.png`

Open both PNGs. Are the variants rendered? Are fonts loaded? Any unexpected provider banner overlapping the content? If yes, fix the fixture and re-approve.

## 4. Commit

```bash
git add apps/web/components/playground/callout-banner
git add apps/web/app/playground/registry.ts apps/web/app/playground/render-map.tsx
git add apps/web/tests/visual/__screenshots__
git commit -m "feat(playground): add callout-banner fixture"
```

The PNGs in the diff are the human-reviewable approval surface — reviewers see exactly what future regressions will be compared against.

## 5. Verify

```bash
bun ui:check
```

The new entry should pass on both `desktop` and `mobile` projects. If it fails immediately after approving, the fixture is non-deterministic — track down the source (date, random id, animation) before merging.
