import { describe, expect, test } from 'bun:test'

import { dockerCliEnv, dockerTestsOptedIn } from './docker-cli-env.ts'

describe('dockerCliEnv', () => {
  test.skipIf(!dockerTestsOptedIn())(
    'runs a script in oven/bun (requires RUN_DOCKER_TESTS=1 and a Docker daemon)',
    () => {
      const env = dockerCliEnv()
      const stdout = env.runScript({
        image: 'oven/bun:1.3.14',
        script: 'bun -e "console.log(process.env.DUET_DOCKER_PIN)"',
        env: { DUET_DOCKER_PIN: 'docker-cli-env-ok' },
      })

      expect(stdout.trim()).toBe('docker-cli-env-ok')
    },
    360_000,
  )
})
