#!/usr/bin/env node
/**
 * Delete columns from a live Convex deployment, one table at a time.
 *
 *   strip-fields.mjs <staging|production> <table> <field...>
 *
 * Export that one table, remove the fields textually, and
 * `convex import --table … --replace` it back.
 *
 * ---- why not export → transform → import --replace-all ----
 * That moves the whole database, file storage included — ~800MB and several
 * minutes to delete two keys off 32 rows. It was the first approach here and it
 * was wrong. A single-table `--replace` **preserves `_id`**, which was the only
 * reason to think the whole-snapshot route was necessary; that was an
 * assumption, never checked, and it is false. Measured on 32 staging
 * workspaces: every id identical before and after.
 *
 * ---- why the rewrite is textual ----
 * Convex encodes a float64 as `1785947866913.0`. `JSON.stringify` drops the
 * `.0`, retyping the value as int64, and the schema then rejects it:
 *
 *     Path: .createdAt  Value: 1785947866913  Validator: v.float64()
 *
 * So fields are cut out of the raw line and every other byte — including every
 * number's exact spelling — is left alone.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [env, table, ...fields] = process.argv.slice(2)
if (!env || !table || fields.length === 0 || !['staging', 'production'].includes(env)) {
  console.error('usage: strip-fields.mjs <staging|production> <table> <field...>')
  process.exit(64)
}

const prod = env === 'production' ? ['--prod'] : []
const work = mkdtempSync(join(tmpdir(), 'strip-'))
const zip = join(work, 'export.zip')
const run = args => execFileSync('bunx', ['convex', ...args], { stdio: 'inherit' })

console.log(`\n== ${env}/${table}: exporting`)
run(['export', ...prod, '--path', zip])
execFileSync('unzip', ['-oq', zip, '-d', join(work, 'data')])

const path = join(work, 'data', table, 'documents.jsonl')
if (!existsSync(path)) {
  console.log(`${table} is not in this deployment — nothing to do`)
  process.exit(0)
}

const lines = readFileSync(path, 'utf8')
  .split('\n')
  .filter(l => l.trim().length > 0)
let touched = 0
const out = lines.map(line => {
  let next = line
  for (const field of fields) {
    // scalar or quoted string, with whichever separator sits beside it
    next = next.replace(
      new RegExp(`,?"${field}":(?:-?\\d+\\.?\\d*(?:[eE][-+]?\\d+)?|"[^"]*"|true|false|null)`),
      '',
    )
  }
  if (next !== line) touched += 1
  return next
})

// Every row must still parse, and no named field may survive.
for (const [index, line] of out.entries()) {
  const row = JSON.parse(line)
  for (const field of fields) {
    if (field in row) throw new Error(`${table}: ${field} survived on row ${index + 1}`)
  }
}
console.log(`${table}: ${touched} of ${out.length} rows rewritten`)
if (touched === 0) {
  console.log('already clean — not importing')
  process.exit(0)
}

/* An empty table must stay a zero-byte file: writing `'\n'` gives Convex a blank
   first line and it fails the import with "Row 1 wasn't valid JSON". */
const jsonl = join(work, `${table}.jsonl`)
writeFileSync(jsonl, out.length === 0 ? '' : out.join('\n') + '\n')

console.log(`\n== ${env}/${table}: importing`)
run(['import', ...prod, '--table', table, '--replace', '-y', '--format', 'jsonLines', jsonl])
console.log('\ndone — `_id`s are preserved by a single-table replace, verified on staging')
