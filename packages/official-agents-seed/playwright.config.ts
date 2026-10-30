import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  testMatch: '**/*.visual.ts',
  fullyParallel: false,
  maxFailures: Number(process.env.PLAYWRIGHT_MAX_FAILURES ?? 0),
  workers: 2,
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/official-apps.spec.ts/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
      threshold: 0.3,
    },
  },
  use: {
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
      },
    },
  ],
})
