import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { officialSeedAgents } from '../../manifest'
import { OFFICIAL_APP_VISUAL_SCENARIOS } from './scenarios'

export type OfficialAppCoverageEntry = {
  target: string
  kind: 'fixture'
  fixture: string
}

const OUTPUT = path.join(import.meta.dir, 'coverage-ledger.generated.json')

export function buildOfficialAppCoverageLedger(): OfficialAppCoverageEntry[] {
  return officialSeedAgents
    .flatMap(agent => (agent.apps ?? []).map(app => `${agent.slug}/${app.slug}`))
    .sort()
    .map(target => {
      const candidates = OFFICIAL_APP_VISUAL_SCENARIOS.filter(scene => scene.app === target)
      const representative =
        candidates.find(scene => /-(completed|populated)$/.test(scene.id)) ?? candidates[0]
      if (representative === undefined)
        throw new Error(`No official-app visual fixture covers ${target}`)
      return { target, kind: 'fixture' as const, fixture: representative.id }
    })
}

export function renderOfficialAppCoverageLedger(): string {
  return `${JSON.stringify(buildOfficialAppCoverageLedger(), null, 2)}\n`
}

if (import.meta.main) {
  const rendered = renderOfficialAppCoverageLedger()
  if (process.argv.includes('--write')) {
    await writeFile(OUTPUT, rendered)
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}.`)
  } else if ((await readFile(OUTPUT, 'utf8').catch(() => '')) !== rendered) {
    console.error('Official-app visual coverage ledger drifted; run visual:coverage:write.')
    process.exit(1)
  } else {
    console.log(`Verified ${buildOfficialAppCoverageLedger().length} official app coverage rows.`)
  }
}
