import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  fullyParallel: false,
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      threshold: 0.3,
      maxDiffPixelRatio: 0.005,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: 'http://localhost:3001',
    contextOptions: {
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'],
    },
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
  webServer: {
    command:
      process.env.VISUAL_PREBUILT === '1' ? 'bun run start' : 'bun run build && bun run start',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    timeout: 600_000,
  },
})
