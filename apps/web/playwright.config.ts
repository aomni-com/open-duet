import { defineConfig, devices } from '@playwright/test'

/* The one suite that asks about capability rather than about pixels. It is split
   out by name because the split is the point: the two camera projects must not
   run it (it takes no pictures and would only cost them time), and it must not
   run without a touchscreen (it would pass for the wrong reason). */
const TOUCH_ONLY = /(touch-targets|mobile-composition)\.spec\.ts/

export default defineConfig({
  testDir: 'tests/visual',
  fullyParallel: false,
  maxFailures: Number(process.env.PLAYWRIGHT_MAX_FAILURES ?? 1),
  // Product fixtures run serially enough to keep the optimized Docker build
  // predictable while still exercising both viewports.
  workers: 2,
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      threshold: 0.3,
      maxDiffPixelRatio: 0.005,
      animations: 'disabled',
      // No test focuses an editable field. Avoid Playwright mutating input
      // styles to hide carets while React is still selectively hydrating a
      // large static page.
      caret: 'initial',
    },
  },
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: TOUCH_ONLY,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      /* The camera. It photographs a phone-shaped window — and it photographs it
         with a mouse: `isMobile` sets the mobile viewport meta and nothing else,
         so `(pointer: coarse)` and `(hover: none)` do **not** match here. That is
         deliberate rather than an oversight to fix in place. A baseline is a
         picture, and a picture of a hover state is worth having; what it must not
         be is the only place the product is checked, because everything written
         behind a capability query is invisible to it. `mobile-touch` below is
         where capability is checked, and it takes no pictures at all. */
      name: 'mobile',
      testIgnore: TOUCH_ONLY,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
      },
    },
    {
      /* A real finger, and no baselines.

         `hasTouch` is the whole reason this project exists: it is what makes
         `(pointer: coarse)` match, and without it the 496 mobile baselines have
         been photographing a mouse. Nothing here calls `toHaveScreenshot` — the
         assertions are geometric, so they need no approval step and cannot drift.
         Both viewports run, because the failures are different: 390 is the phone
         the product is designed against and 320 is where a two-column row finally
         gives up. */
      name: 'mobile-touch',
      testMatch: TOUCH_ONLY,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      process.env.VISUAL_PREBUILT === '1' ? 'bun run start' : 'bun run build && bun run start',
    url: 'http://localhost:3000/playground',
    env: {
      ...process.env,
      NEXT_PUBLIC_CONVEX_URL:
        process.env.NEXT_PUBLIC_CONVEX_URL ?? 'https://visual-fixture.convex.cloud',
    },
    // The gate always builds and serves its own, so a stale bundle can never be
    // what a baseline was taken against. `VISUAL_REUSE_SERVER=1` is for driving
    // the geometry assertions against a dev server you already have running —
    // never for taking screenshots, which is why it is opt-in and not `!CI`.
    reuseExistingServer: process.env.VISUAL_REUSE_SERVER === '1',
    timeout: 600_000,
  },
})
