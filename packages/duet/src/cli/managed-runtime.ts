import { existsSync } from 'node:fs'

/** The VM layout identifies managed commands even in a fresh SSH shell. */
export function isManagedRuntime(scriptPath = process.argv[1]): boolean {
  return (
    [process.execPath, scriptPath].some(path => path?.startsWith('/opt/duet/')) ||
    existsSync('/opt/duet/current/manifest.json')
  )
}
