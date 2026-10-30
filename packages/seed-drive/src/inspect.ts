import { inspectSeedArchive } from './bundle'

const archive = await inspectSeedArchive()
for (const entry of archive.entries) console.log(entry)
console.log(`sha256 ${archive.sha256}`)
