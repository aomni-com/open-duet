import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function writePrivateJson(
  directory: string,
  filename: string,
  value: unknown,
  tempPrefix: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('private state directory must not be a symlink')
  }
  await chmod(directory, 0o700)
  const path = resolve(directory, filename)
  const tempPath = resolve(directory, `.${tempPrefix}-${randomBytes(12).toString('hex')}`)
  const file = await open(tempPath, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`)
    await file.sync()
    await file.close()
    await rename(tempPath, path)
    await chmod(path, 0o600)
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export async function readPrivateJson(path: string): Promise<unknown | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return null
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}
