import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configPathForHome, loadConfig, saveConfig } from './config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('duet config', () => {
  test('transfers the harness login once and preserves other provider settings', async () => {
    const home = await tempHome()
    const dir = join(home, '.duet')
    await mkdir(dir)
    const envPath = join(dir, '.env')
    await writeFile(
      envPath,
      '# Providers\nDUET_API_KEY=duet_sk_old\nOPENROUTER_API_KEY=other-provider\n',
    )
    const path = configPathForHome(home)
    expect(await loadConfig(path)).toEqual({ apiKey: 'duet_sk_old' })
    expect(await readFile(envPath, 'utf8')).toBe('# Providers\nOPENROUTER_API_KEY=other-provider\n')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ apiKey: 'duet_sk_old' })
    expect(await loadConfig(path)).toEqual({ apiKey: 'duet_sk_old' })
  })

  test('reads and writes ~/.duet/config.json with 0600 permissions', async () => {
    const home = await tempHome()
    const path = configPathForHome(home)

    await saveConfig(
      {
        apiKey: 'duet_sk_test_secret',
        defaultWorkspace: 'demo',
        apiUrl: 'http://127.0.0.1:9999',
      },
      path,
    )

    expect(await loadConfig(path)).toEqual({
      apiKey: 'duet_sk_test_secret',
      defaultWorkspace: 'demo',
      apiUrl: 'http://127.0.0.1:9999',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('does not read a host config when HOME points at an empty test directory', async () => {
    const home = await tempHome()
    expect(await loadConfig(configPathForHome(home))).toEqual({})
  })
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-config-'))
  tempDirs.push(dir)
  return dir
}
