/* The geometry checks, against a dev server you already have running.

   `playwright.config.ts` is the one that matters: it builds the app, serves the
   optimized artifact, and shoots the committed baselines in the pinned Linux
   image. Nothing here writes a baseline and nothing here is a gate — a
   screenshot taken on a Mac against `next dev` is a different picture from the
   one CI compares, and approving one from here is how a suite starts drifting.

   What this is for is the other half of the visual suite: the tests that
   *measure* rather than shoot. `nothing on the … surface overlaps anything else`
   reads element boxes, and those are the same on a dev server as on a build —
   so it can run in two seconds against `bun run dev` on :3000 instead of six
   minutes through Docker, which is the difference between checking a layout
   every time you touch it and checking it once at the end.

     bun --cwd apps/web exec playwright test --config playwright.dev.config.ts \
       -g "overlaps anything else in"

   One project, because it drives its own viewport sizes; one worker, because the
   camera settles per page and parallel pages fight over the same dev server. */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  /* This config may not touch a baseline, in either direction.

     The header above says a shot taken on a Mac against `next dev` is a
     different picture from the one CI compares — but saying it did not stop it
     happening: running a spec that carries `toHaveScreenshot` from here wrote
     thirty-one host PNGs into a `*-snapshots/` directory beside the committed
     ones, and every screenshot assertion failed for the honest reason that its
     baseline was somewhere else. `ignoreSnapshots` makes the rule the config's
     rather than the reader's: screenshot assertions become no-ops here, the
     measurement tests this file exists for still run, and there is nothing left
     to accidentally approve. */
  ignoreSnapshots: true,
  /* Whatever `bun run dev` gave you. Three is the default because that is what
     the script asks for; a worktree whose port was already taken exports
     `PLAYWRIGHT_BASE_URL` and measures its own server rather than somebody
     else's checkout of the same file. */
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000' },
  projects: [
    {
      /* The touch suite takes no pictures, so it is safe here: this config exists
         for the assertions that measure rather than shoot, and that is exactly
         what `touch-targets.spec.ts` is. */
      name: 'mobile-touch',
      testMatch: /(touch-targets|mobile-composition)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      testIgnore: /(touch-targets|mobile-composition)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
})
