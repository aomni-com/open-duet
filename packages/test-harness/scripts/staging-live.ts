import { stagingLiveLegsPassed } from '../src/staging-live-env.ts'
import { parseStagingLiveSelection, STAGING_JOURNEYS } from '../src/staging-live-selection.ts'
import { runStagingLiveFullRun } from '../src/staging-live.ts'

const selection = parseStagingLiveSelection(process.argv.slice(2))

if (selection.kind === 'journey') {
  const journey = STAGING_JOURNEYS[selection.name]
  const result = await journey
    .run({
      onProgress: stage =>
        console.log(`STAGING_LIVE_PROGRESS ${JSON.stringify({ journey: selection.name, stage })}`),
    })
    .catch(error => {
      console.error(
        `STAGING_LIVE_JOURNEY_FAILED ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
      return undefined
    })
  if (result !== undefined) {
    console.log(`STAGING_LIVE_JOURNEY_EVIDENCE ${JSON.stringify(result)}`)
  }
} else {
  const result = await runStagingLiveFullRun({
    onProgress: progress => console.log(`STAGING_LIVE_PROGRESS ${JSON.stringify(progress)}`),
  }).catch(error => ({
    steps: {},
    legs: { overall: { status: 'fail' as const } },
    vmNames: [],
    error: error instanceof Error ? error.message : String(error),
  }))

  console.log(`STAGING_LIVE_TIMELINE ${JSON.stringify(result)}`)
  process.exitCode = stagingLiveLegsPassed(
    result.legs,
    process.env.DUET_E2E_ALLOW_GOOGLE_OAUTH_SKIP === '1',
  )
    ? 0
    : 1
}
