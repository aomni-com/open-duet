import { expect, test } from 'bun:test'

import { buildAppSpawnEnv } from './spawn-env'

test('app spawn environment keeps the runtime minimum and drops gateway secrets', () => {
  expect(
    buildAppSpawnEnv({
      base: {
        PATH: '/opt/duet/bin:/usr/bin',
        HOME: '/home/duet',
        PORT: 'gateway-port',
        DUET_PROVISIONING_TOKEN: 'provisioning-secret',
        SENTINEL_GATEWAY_SECRET: 'sentinel-secret',
      },
      port: 43123,
    }),
  ).toEqual({
    PATH: '/opt/duet/bin:/usr/bin',
    HOME: '/home/duet',
    PORT: '43123',
  })
})

test('service-only extras are added without allowing them to replace the assigned port', () => {
  expect(
    buildAppSpawnEnv({
      base: { PATH: '/usr/bin', HOME: '/home/duet' },
      port: 43123,
      extras: { DUET_APP_API_KEY: 'app-secret', PORT: 'wrong-port' },
    }),
  ).toEqual({
    PATH: '/usr/bin',
    HOME: '/home/duet',
    DUET_APP_API_KEY: 'app-secret',
    PORT: '43123',
  })
})
