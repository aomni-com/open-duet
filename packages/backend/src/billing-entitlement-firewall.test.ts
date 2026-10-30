import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PRODUCTION_ROOTS = ['apps', 'packages']
// The playground renders canned fixture data, never a live entitlement gate,
// so its mock billing rows are not the firewall's subject. Excluding the whole
// directory keeps a fixture split from reddening this test for no behavior
// change — the failure mode that a per-file allowlist invites.
const EXCLUDED_DIRECTORIES = new Set([
  '.next',
  '.turbo',
  '_generated',
  'dist',
  'node_modules',
  'playground',
  'testing',
])
const BOOKKEEPING_PATHS = new Set([
  'packages/backend/convex/domains/credits/subscriptions.ts',
  'packages/backend/convex/domains/credits/topups.ts',
  'packages/backend/convex/domains/credits/userBilling.ts',
  'packages/backend/convex/domains/users/queries.ts',
  'packages/backend/convex/schema.ts',
  'packages/contract/src/billing/index.ts',
])

describe('billing entitlement firewall', () => {
  test('production entitlement gates never read billing.firstPaidAt', () => {
    const violations: string[] = []
    for (const relativeFile of productionTypeScriptFiles()) {
      const lines = readFileSync(path.join(REPO_ROOT, relativeFile), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!line.includes('firstPaidAt')) return
        // Bookkeeping owners may write AND read the stamp (e.g. classifying a
        // purchase as started-vs-renewed for analytics); the firewall exists
        // to keep it out of entitlement gates elsewhere.
        if (BOOKKEEPING_PATHS.has(relativeFile)) return
        violations.push(`${relativeFile}:${index + 1}: ${line.trim()}`)
      })
    }

    expect(violations).toEqual([])
  })
})

function productionTypeScriptFiles(): string[] {
  return PRODUCTION_ROOTS.flatMap(root => walk(path.join(REPO_ROOT, root))).map(file =>
    path.relative(REPO_ROOT, file),
  )
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : walk(absolute)
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) {
      return []
    }
    return [absolute]
  })
}
