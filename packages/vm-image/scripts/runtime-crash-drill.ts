import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createBootHealth, readBootState, writeBootState } from '../../gateway/src/boot-health'
import { runRuntimeBootstrap } from '../../gateway/src/runtime-bootstrap'
import { runtimeFixture } from '../../gateway/src/testing/runtime-release-fixture'

export async function runRuntimeCrashDrill(): Promise<Record<string, string | number | undefined>> {
  const root = await mkdtemp(join(tmpdir(), 'duet-runtime-crash-drill-'))
  const stateDir = join(root, 'state')
  const releasesDir = join(root, 'releases')
  const currentReleaseLink = join(root, 'current')
  const previousReleaseLink = join(root, 'previous')
  const good = runtimeFixture('good-release')
  const poisoned = runtimeFixture('poisoned-release')
  let now = 0

  try {
    await good.write(join(releasesDir, good.manifest.version))
    await poisoned.write(join(releasesDir, poisoned.manifest.version))
    await symlink(join(releasesDir, poisoned.manifest.version), currentReleaseLink)
    await symlink(join(releasesDir, good.manifest.version), previousReleaseLink)
    await writeBootState(stateDir, {
      attemptedVersion: poisoned.manifest.version,
      consecutiveFailures: 0,
      previousVersion: good.manifest.version,
    })

    let simulatedCrashes = 0
    for (; simulatedCrashes < 32; simulatedCrashes += 1) {
      const poisonedProcess = createBootHealth({ stateDir, now: () => now })
      await poisonedProcess.recordSyncOk()
      now += 2_000
      const code = await runRuntimeBootstrap(
        {
          DUET_STATE_DIR: stateDir,
          DUET_RELEASES_DIR: releasesDir,
          DUET_CURRENT_RELEASE_LINK: currentReleaseLink,
          DUET_PREVIOUS_RELEASE_LINK: previousReleaseLink,
        },
        { bootId: async () => `drill-${simulatedCrashes + 1}`, log: () => undefined },
      )
      if (code !== 0)
        throw new Error(`bootstrap failed after simulated crash ${simulatedCrashes + 1}`)
      if (basename(await readlink(currentReleaseLink)) === good.manifest.version) {
        simulatedCrashes += 1
        break
      }
    }

    if (basename(await readlink(currentReleaseLink)) !== good.manifest.version) {
      throw new Error('Runtime did not roll back within the bounded crash drill')
    }
    const beforeHealth = await readBootState(stateDir)
    const goodProcessStartedAt = now
    const goodProcess = createBootHealth({
      stateDir,
      now: () => now,
      minUptimeMs: 37,
      minSyncOks: 2,
    })
    await goodProcess.recordSyncOk()
    await goodProcess.recordSyncOk()
    now += 37
    await goodProcess.recordSyncOk()
    const afterHealth = await readBootState(stateDir)

    return {
      simulatedCrashes,
      rolledBackTo: basename(await readlink(currentReleaseLink)),
      quarantinedVersion: beforeHealth?.quarantinedVersion,
      consecutiveFailuresBeforeHealth: beforeHealth?.consecutiveFailures,
      healthyVersion: afterHealth?.healthyVersion,
      healthyAfterMs: now - goodProcessStartedAt,
      consecutiveFailuresAfterHealth: afterHealth?.consecutiveFailures,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) console.log(JSON.stringify(await runRuntimeCrashDrill()))
