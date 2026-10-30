import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { deleteKey, handle, planChanges, readEnv, setKey } from './server'

// planChanges is the pure decision layer the Save flow runs: given what's on disk
// plus the queued edits/deletes, decide what to write, drop, skip, or reject. No I/O.
describe('planChanges', () => {
  test('skips a key whose value is unchanged (keeps git quiet)', () => {
    const plan = planChanges({ A: '1' }, { A: '1' }, [])
    expect(plan.toSet).toEqual([])
    expect(plan.skipped).toEqual(['A'])
  })

  test('writes changed and brand-new keys', () => {
    const plan = planChanges({ A: '1' }, { A: '2', B: 'new' }, [])
    expect(plan.toSet).toEqual([
      { key: 'A', value: '2' },
      { key: 'B', value: 'new' },
    ])
  })

  test('queues a delete only when the key exists on disk', () => {
    expect(planChanges({ A: '1' }, {}, ['A']).toDelete).toEqual(['A'])
    expect(planChanges({}, {}, ['GONE']).toDelete).toEqual([])
  })

  test('a queued delete wins over an edit of the same key', () => {
    const plan = planChanges({ A: '1' }, { A: 'edited' }, ['A'])
    expect(plan.toDelete).toEqual(['A'])
    expect(plan.toSet).toEqual([])
  })

  test('rejects invalid key names from both edits and deletes', () => {
    expect(planChanges({}, { 'bad-key': 'x' }, []).invalid).toEqual(['bad-key'])
    expect(planChanges({}, {}, ['also bad']).invalid).toEqual(['also bad'])
  })
})

const DOTENVX = resolve('node_modules/.bin/dotenvx')
const previousEditorDirectory = process.env.SECRETS_EDITOR_DIR
function restoreEditorDirectory() {
  if (previousEditorDirectory === undefined) delete process.env.SECRETS_EDITOR_DIR
  else process.env.SECRETS_EDITOR_DIR = previousEditorDirectory
}

// Line-removal is pure fs and never needs dotenvx, so test it directly on a plaintext file.
describe('deleteKey', () => {
  let d: string
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'secrets-del-'))
    process.env.SECRETS_EDITOR_DIR = d
  })
  afterAll(() => {
    restoreEditorDirectory()
    rmSync(d, { recursive: true, force: true })
  })

  test('removes the exact key line, leaving prefix-similar keys and others intact', () => {
    writeFileSync(join(d, '.env.production'), 'FOO=1\nFOO_BAR=2\nBAZ=3\n')
    expect(deleteKey('production', 'FOO')).toBe(true)
    expect(readFileSync(join(d, '.env.production'), 'utf8')).toBe('FOO_BAR=2\nBAZ=3\n')
  })

  test('returns false when the key is absent (no rewrite)', () => {
    writeFileSync(join(d, '.env.production'), 'FOO=1\n')
    expect(deleteKey('production', 'MISSING')).toBe(false)
    expect(readFileSync(join(d, '.env.production'), 'utf8')).toBe('FOO=1\n')
  })
})

// Drive the real HTTP entry point the browser hits — POST /api/secrets — through the
// real dotenvx CLI, fully isolated: cwd is the temp dir, so the generated .env.keys
// lands there and never touches the repo's real key file.
//
// Every case below spawns the dotenvx CLI with `execFileSync`, several times over, and
// a process spawn is not work this file controls the speed of. Measured: this block
// alone takes about forty seconds on an idle machine, so the five-second default was
// never a budget these tests could meet — it only looked survivable because the block
// *skips itself* unless `node_modules/.bin/dotenvx` resolves, and it resolves from the
// repo root and nowhere else. Run the file from this directory and ten cases quietly
// skip; run it from the root, under turbo, with every other package's tests competing
// for the machine, and they run and time out. That is how the root gate went red on a
// tool nobody had touched.
//
// So the budget is stated here, where the reason is, and it covers the hooks too — the
// seed shells out as hard as the cases do, and a hook timeout is the failure this
// actually produced first. A generous number is honest here in a way it would not be
// for a unit test: nothing below asserts how *fast* dotenvx is, only what it writes.
const REAL_DOTENVX_TIMEOUT_MS = 60_000

describe.skipIf(!existsSync(DOTENVX))('POST /api/secrets (real dotenvx, isolated dir)', () => {
  let d: string
  let seededProduction: string
  let seededStaging: string
  type SaveResp = {
    error?: string
    updated?: string[]
    deleted?: string[]
    errors?: { key: string; message: string }[]
    all?: { production: Record<string, string>; staging: Record<string, string> }
  }
  const save = async (body: unknown) => {
    const res = await handle(
      new Request('http://local/api/secrets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: res.status, data: (await res.json()) as SaveResp }
  }

  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'secrets-save-'))
    process.env.SECRETS_EDITOR_DIR = d
    writeFileSync(join(d, '.env.production'), '')
    writeFileSync(join(d, '.env.staging'), '')
    // Seed both files (setKey encrypts, generating a keypair into the temp dir's .env.keys).
    setKey('production', 'ALPHA', 'a1')
    setKey('production', 'BETA', 'b1')
    setKey('production', 'SHARED', 'same')
    setKey('staging', 'GAMMA', 'g1')
    setKey('staging', 'SHARED', 'same')
    seededProduction = readFileSync(join(d, '.env.production'), 'utf8')
    seededStaging = readFileSync(join(d, '.env.staging'), 'utf8')
  }, REAL_DOTENVX_TIMEOUT_MS)
  beforeEach(() => {
    writeFileSync(join(d, '.env.production'), seededProduction)
    writeFileSync(join(d, '.env.staging'), seededStaging)
  })
  afterAll(() => {
    restoreEditorDirectory()
    rmSync(d, { recursive: true, force: true })
  }, REAL_DOTENVX_TIMEOUT_MS)

  test('seed decrypts back to the plaintext values', () => {
    expect(readEnv('production')).toEqual({ ALPHA: 'a1', BETA: 'b1', SHARED: 'same' })
  })

  test(
    'rejects an unknown scope with 400',
    async () => {
      const { status, data } = await save({ scope: 'nope', entries: {}, deletes: [] })
      expect(status).toBe(400)
      expect(data.error).toContain('unknown scope')
    },
    REAL_DOTENVX_TIMEOUT_MS,
  )

  test(
    'one save applies an edit, skips an unchanged key, and commits a queued delete',
    async () => {
      const { data } = await save({
        scope: 'production',
        entries: { ALPHA: 'a1', BETA: 'CHANGED' },
        deletes: ['SHARED'],
      })
      expect(data.updated).toEqual(['BETA']) // ALPHA unchanged → skipped
      expect(data.deleted).toEqual(['SHARED'])
      expect(data.errors).toEqual([])
      // The response echoes the fresh decrypted state...
      expect(data.all?.production).toEqual({ ALPHA: 'a1', BETA: 'CHANGED' })
      // ...and it matches what's actually on disk; the env-scoped delete left staging alone.
      expect(readEnv('production')).toEqual({ ALPHA: 'a1', BETA: 'CHANGED' })
      expect(readEnv('staging')).toEqual({ GAMMA: 'g1', SHARED: 'same' })
    },
    REAL_DOTENVX_TIMEOUT_MS,
  )

  test(
    'a queued delete overrides an edit of the same key',
    async () => {
      const { data } = await save({
        scope: 'production',
        entries: { ALPHA: 'zzz' },
        deletes: ['ALPHA'],
      })
      expect(data.deleted).toEqual(['ALPHA'])
      expect(data.updated).not.toContain('ALPHA')
      expect(readEnv('production')).toEqual({ BETA: 'b1', SHARED: 'same' })
    },
    REAL_DOTENVX_TIMEOUT_MS,
  )

  test(
    'shared-scope delete removes the key from both files',
    async () => {
      const { data } = await save({ scope: 'shared', entries: {}, deletes: ['SHARED'] })
      expect(data.deleted).toEqual(['SHARED'])
      expect(readEnv('production')).toEqual({ ALPHA: 'a1', BETA: 'b1' })
      expect(readEnv('staging')).toEqual({ GAMMA: 'g1' })
    },
    REAL_DOTENVX_TIMEOUT_MS,
  )
})

// Regression: Bun auto-loads .env.local, so the editor's process.env already holds these
// secrets at launch. dotenvx merges process.env, which makes `get` return the env value
// over the file AND makes `set` skip a write whose value already matches the env (exit 0,
// file untouched) — so edits silently no-op. The tool must scrub managed keys from the
// dotenvx child env. The shadow has to be present at CHILD LAUNCH (Bun ignores runtime
// process.env mutations for spawned children), so this drives it through a subprocess and
// verifies the file from the parent, whose env is clean.
describe.skipIf(!existsSync(DOTENVX))('dotenvx child env is scrubbed of managed keys', () => {
  let d: string
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'secrets-shadow-'))
    process.env.SECRETS_EDITOR_DIR = d
    setKey('production', 'SHADOW', 'REPLACE_ME') // seed placeholder (parent env has no SHADOW)
  }, REAL_DOTENVX_TIMEOUT_MS)
  afterAll(() => {
    restoreEditorDirectory()
    rmSync(d, { recursive: true, force: true })
  }, REAL_DOTENVX_TIMEOUT_MS)

  test(
    'setKey persists a value equal to a key shadowed in the launch env',
    () => {
      const script =
        `process.env.SECRETS_EDITOR_DIR=${JSON.stringify(d)};` +
        `const m=await import(${JSON.stringify(resolve('tools/secrets-editor/server.ts'))});` +
        `m.setKey('production','SHADOW','realtoken');`
      // Child launched WITH SHADOW=realtoken — mirrors Bun's .env.local auto-load. It sets
      // SHADOW to that same value; unscrubbed, dotenvx would treat it as a no-op and skip.
      execFileSync('bun', ['-e', script], { env: { ...process.env, SHADOW: 'realtoken' } })
      // Parent env has no SHADOW, so readEnv reports the true on-disk value.
      expect(readEnv('production').SHADOW).toBe('realtoken')
    },
    REAL_DOTENVX_TIMEOUT_MS,
  )
})
