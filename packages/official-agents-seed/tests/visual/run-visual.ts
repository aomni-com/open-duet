import { OFFICIAL_APP_VISUAL_SCENARIOS } from './scenarios'
import {
  expectedOfficialAppScreenshots,
  removeStaleOfficialAppScreenshots,
  verifyOfficialAppScreenshots,
} from './verify-screenshots'

type Mode = 'check' | 'approve' | 'approve-force'

export function isFilteredOfficialAppRun(args: readonly string[]): boolean {
  const grepIndex = args.findIndex(arg => arg === '-g' || arg === '--grep')
  if (grepIndex === -1) return false
  return args[grepIndex + 1] !== 'official-apps/'
}

if (import.meta.main) {
  const [modeValue, ...playwrightArgs] = process.argv.slice(2)
  const mode = modeValue as Mode
  if (!['check', 'approve', 'approve-force'].includes(mode)) {
    console.error('usage: run-visual.ts check|approve|approve-force [playwright args]')
    process.exit(2)
  }

  const command = [process.execPath, '--bun', 'playwright', 'test']
  if (mode === 'approve') command.push('--update-snapshots=changed')
  if (mode === 'approve-force') command.push('--update-snapshots=all')
  command.push(...playwrightArgs)

  const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)

  let result = await verifyOfficialAppScreenshots()
  const filtered = isFilteredOfficialAppRun(playwrightArgs)
  if (mode !== 'check' && !filtered && result.stale.length > 0) {
    await removeStaleOfficialAppScreenshots(
      new URL('./__screenshots__/', import.meta.url).pathname,
      result.stale,
    )
    result = await verifyOfficialAppScreenshots()
  }

  for (const file of result.missing) console.error(`missing screenshot: ${file}`)
  for (const file of result.stale) console.error(`stale screenshot: ${file}`)
  if (result.missing.length > 0 || result.stale.length > 0) process.exit(1)
  console.log(
    `Verified ${OFFICIAL_APP_VISUAL_SCENARIOS.length} official-app scenes and ${expectedOfficialAppScreenshots().length} screenshots.`,
  )
}
