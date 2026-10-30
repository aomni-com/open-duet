// Regenerates content.generated.ts from the authored content/ tree. Run
// `bun run codegen` after editing seed agents; the drift test fails until
// the generated module matches the files.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderGeneratedContentModule } from './index'

const here = dirname(fileURLToPath(import.meta.url))
await writeFile(join(here, 'content.generated.ts'), await renderGeneratedContentModule())
console.log('wrote src/content.generated.ts')
