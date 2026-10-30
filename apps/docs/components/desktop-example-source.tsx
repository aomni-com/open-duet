import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { CodeBlock } from './code-block'

const EXAMPLE_FILES = {
  contract: 'desktop-contract.ts',
  backend: 'desktop-backend.ts',
  browser: 'desktop-browser.ts',
} as const

export async function DesktopExampleSource({ file }: { file: keyof typeof EXAMPLE_FILES }) {
  const source = await readFile(path.join(process.cwd(), 'examples', EXAMPLE_FILES[file]), 'utf8')
  return (
    <CodeBlock>
      <code className="language-ts">{source.trim()}</code>
    </CodeBlock>
  )
}
