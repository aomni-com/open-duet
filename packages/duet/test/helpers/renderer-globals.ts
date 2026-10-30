import { restoreWindowGlobal } from '../../src/tui/renderer-lifecycle.js'

/** OpenTUI installs animation globals and a partial window shim; PGlite must see the host again after teardown. */
export function snapshotRendererGlobals(): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const targets: Array<[object, string]> = [
    [globalThis, 'requestAnimationFrame'],
    [globalThis, 'cancelAnimationFrame'],
  ]
  const window: unknown = Reflect.get(globalThis, 'window')
  if (typeof window === 'object' && window !== null) targets.push([window, 'requestAnimationFrame'])
  const snapshots = targets.map(([target, name]) => ({
    target,
    name,
    descriptor: Object.getOwnPropertyDescriptor(target, name),
  }))
  return () => {
    restoreWindowGlobal(previousWindow)
    for (const { target, name, descriptor } of snapshots) {
      if (descriptor) Object.defineProperty(target, name, descriptor)
      else Reflect.deleteProperty(target, name)
    }
  }
}
