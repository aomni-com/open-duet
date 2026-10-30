import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_ROUTING_TABLE } from '@repo/agent/model-routing/table'

const contents = JSON.stringify({ table: BUILT_IN_ROUTING_TABLE }, null, 2) + '\n'
const destination = fileURLToPath(new URL('../src/runner/routing-table.json', import.meta.url))
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')) !== contents)
    throw new Error('Routing table is stale; run bun run routing:export in packages/gateway')
} else {
  await writeFile(destination, contents)
}
