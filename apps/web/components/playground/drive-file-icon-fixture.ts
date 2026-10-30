import type { DuetApiClient } from '../../spa/api/client'
import { MockFileSystemProvider } from '../../spa/files/lib/mock-provider'

export const DRIVE_FILE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M18 37c7-17 21-17 28 0" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="24" cy="26" r="4" fill="white"/><circle cx="40" cy="26" r="4" fill="white"/></svg>'

export function createDriveFileIconFixture(paths: string[]) {
  const provider = new MockFileSystemProvider()
  provider.seed(
    paths.map(path => ({ path, data: DRIVE_FILE_ICON_SVG, contentType: 'image/svg+xml' })),
  )
  return {
    provider,
    client: {
      workspaceFileDownloadUrl: (...args: Parameters<DuetApiClient['workspaceFileDownloadUrl']>) =>
        provider.downloadUrl(args[1]),
    },
  }
}

export function driveFileIconFixtureClient(provider: MockFileSystemProvider) {
  return {
    workspaceFileDownloadUrl: (...args: Parameters<DuetApiClient['workspaceFileDownloadUrl']>) =>
      provider.downloadUrl(args[1]),
  }
}
