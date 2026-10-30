import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createControlledOfficialAppEdge,
  OFFICIAL_APP_DRIVERS,
  type ControlledOfficialAppEdge,
  type OfficialAppKey,
  type RunningOfficialApp,
} from './drivers'

export interface IsolatedOfficialApp extends RunningOfficialApp {
  directory: string
  edge: ControlledOfficialAppEdge
}

export async function withOfficialApp<T>(
  key: OfficialAppKey,
  run: (app: IsolatedOfficialApp) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'duet-official-app-visual-'))
  const edge = createControlledOfficialAppEdge()
  let app: RunningOfficialApp | undefined
  try {
    const driver = OFFICIAL_APP_DRIVERS[key]
    if (driver === undefined) throw new Error(`No official app visual driver for ${key}`)
    app = driver.start({ directory, port: 0, edge })
    return await run({ ...app, directory, edge })
  } finally {
    try {
      await app?.stop()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
