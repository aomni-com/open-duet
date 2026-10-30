import { buildOfficialSyncPlan } from './index'

// What a sync would write, answerable without a hub. The managed roots come
// from the manifest, so an agent authored under content/ but absent from
// manifest.ts shows up nowhere here — which is exactly what demotion looks
// like.
const plan = buildOfficialSyncPlan()

for (const agent of plan.agents) {
  console.log(`${agent.path}/  (${agent.slug} — ${agent.name})`)
  // The catalog half of the plan. It is derived from the bytes below rather
  // than declared beside them, so printing both together is the only way to
  // see that an authored change reached the listing a browser will read.
  console.log(`  listing summary: ${agent.derived.summary}`)
  console.log(`  listing skills:  ${agent.derived.skills.join(', ') || '(none)'}`)
  console.log(`  changelog:       ${agent.derived.changelog === '' ? '(none)' : 'present'}`)
  console.log(`  listing tags:    ${agent.derived.tags.join(', ') || '(none)'}`)
  for (const file of plan.files.filter(entry => entry.path.startsWith(`${agent.path}/`))) {
    console.log(`  ${file.path} ${file.sha256}`)
  }
}
console.log(`${plan.files.length} managed files across ${plan.agents.length} agents`)
