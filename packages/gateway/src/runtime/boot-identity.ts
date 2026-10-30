import { readFileSync } from 'node:fs'

/** OS identity differs from the gateway instance ID, which changes on a service restart. */
export function createBootIdReader(
  platform: string = process.platform,
  read: () => string = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
) {
  let readOnce = false
  let bootId: string | undefined
  return () => {
    if (!readOnce) {
      readOnce = true
      if (platform === 'linux') bootId = read().trim()
    }
    return bootId
  }
}

export const readProcessBootId = createBootIdReader()
