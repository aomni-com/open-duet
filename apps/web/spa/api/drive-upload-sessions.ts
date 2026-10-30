import { duetApi, type DuetApiClient } from './client'
import { VmUploadClient, type UploadRequest, type VmUploadGrant } from './vm-uploads'

type DriveUploadApi = Pick<DuetApiClient, 'mintDriveUploadSession'>

/**
 * Permission to write one Drive folder from the browser.
 *
 * `VmUploadClient` owns the transport; this owns the credential it needs. Every
 * surface that sends a picked file — the drive, the compose bar — asks here, so
 * there is one answer to how a grant is obtained and how long it is reused.
 *
 * Who the write is credited to is deliberately *not* this object's business.
 * The grant itself carries the actor, stamped by the API from the authenticated
 * caller, so a browser can neither assert an identity nor forget to — and
 * forgetting is exactly what once made these uploads land as `system`.
 */
export class DriveUploadSessions {
  private readonly workspaceSlug: string
  private readonly api: DriveUploadApi
  private readonly uploads: VmUploadClient
  private readonly mints = new Map<string, () => Promise<VmUploadGrant>>()

  constructor(options: { workspaceSlug: string; api?: DriveUploadApi; uploads?: VmUploadClient }) {
    this.workspaceSlug = options.workspaceSlug
    this.api = options.api ?? duetApi
    this.uploads = options.uploads ?? new VmUploadClient()
  }

  put(
    pathPrefix: string,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ): UploadRequest {
    return this.uploads.putFromSession(this.mint(pathPrefix), filename, file, onProgress)
  }

  async delete(pathPrefix: string, filename: string): Promise<void> {
    await this.uploads.delete(await this.uploads.session(this.mint(pathPrefix)), filename)
  }

  /**
   * One mint per folder, kept by identity.
   *
   * `VmUploadClient` caches a grant against the exact function it was handed,
   * so a second file dropped into the same folder only reuses the first one's
   * grant if it arrives with the same closure. Building a fresh one per call
   * would re-mint for every file and nothing would fail.
   */
  private mint(pathPrefix: string): () => Promise<VmUploadGrant> {
    let mint = this.mints.get(pathPrefix)
    if (mint === undefined) {
      mint = () => this.api.mintDriveUploadSession(this.workspaceSlug, pathPrefix)
      this.mints.set(pathPrefix, mint)
    }
    return mint
  }
}
