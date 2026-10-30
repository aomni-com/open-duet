import { beforeEach, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'

/** Capture the real subprocess edge so app fixtures can await owned shutdown. */
export function trackAppProcesses(): { stopChildren(): Promise<void> } {
  const children: Array<{ child: childProcess.ChildProcess; closed: Promise<void> }> = []
  const realSpawn = childProcess.spawn
  let spawnSpy: ReturnType<typeof spyOn<typeof childProcess, 'spawn'>>
  beforeEach(() => {
    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((
      ...args: Parameters<typeof childProcess.spawn>
    ) => {
      const child = realSpawn(...args)
      children.push({ child, closed: new Promise(resolve => child.once('close', () => resolve())) })
      return child
    }) as typeof childProcess.spawn)
  })
  return {
    async stopChildren() {
      try {
        for (const { child } of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          } catch {}
          child.kill('SIGKILL')
        }
        await Promise.all(children.splice(0).map(value => value.closed))
      } finally {
        spawnSpy.mockRestore()
      }
    },
  }
}
