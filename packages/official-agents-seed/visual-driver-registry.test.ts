import { describe, expect, test } from 'bun:test'
import { access } from 'node:fs/promises'

import { officialSeedAgents } from './manifest'
import { OFFICIAL_APP_DRIVERS } from './tests/visual/drivers'
import { withOfficialApp } from './tests/visual/harness'

describe('official app visual drivers', () => {
  test('has exactly one production driver for every manifest app', () => {
    const manifestKeys = officialSeedAgents.flatMap(agent =>
      (agent.apps ?? []).map(app => `${agent.slug}/${app.slug}`),
    )

    expect(Object.keys(OFFICIAL_APP_DRIVERS).sort()).toEqual(manifestKeys.sort())
  })

  test('stops the server and removes scene state after an assertion fails', async () => {
    let directory = ''
    let url: URL | undefined

    await expect(
      withOfficialApp('account-researcher/account-board', async running => {
        directory = running.directory
        url = running.url
        throw new Error('visual assertion failed')
      }),
    ).rejects.toThrow('visual assertion failed')

    await expect(access(directory)).rejects.toThrow()
    await expect(fetch(url!)).rejects.toThrow()
  })
})
