import { runAppsLiveAcceptance } from '../src/apps-live.ts'

const evidence = await runAppsLiveAcceptance({
  onProgress: stage => console.log(`APPS_LIVE_PROGRESS ${stage}`),
}).catch(error => {
  console.error(`APPS_LIVE_FAILED ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
  return undefined
})

if (evidence !== undefined) {
  console.log(`APPS_LIVE_EVIDENCE ${JSON.stringify(evidence, undefined, 2)}`)
}
