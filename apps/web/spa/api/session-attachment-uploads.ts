import { attachmentLandingPrefix } from '@repo/contract'

import { duetApi, type DuetApiClient } from './client'
import { DriveUploadSessions } from './drive-upload-sessions'
import type { UploadRequest, VmUploadClient } from './vm-uploads'

type AttachmentUploadApi = Pick<
  DuetApiClient,
  'mintDriveUploadSession' | 'operateOnWorkspaceFiles' | 'statOptionalWorkspaceFile'
>

/**
 * The compose bar's side of an attachment: where a file lands, what it may be
 * called, and where it moves when the draft changes agent.
 *
 * Sending the bytes is `DriveUploadSessions`' job. What is left here is the
 * part only the composer knows — that an attachment belongs to an agent's
 * `cwd`, and that a `cwd` names the upload folder underneath it.
 */
export class SessionAttachmentUploads {
  private readonly workspaceSlug: string
  private readonly api: AttachmentUploadApi
  private readonly uploads: DriveUploadSessions

  constructor(options: {
    workspaceSlug: string
    api?: AttachmentUploadApi
    uploads?: VmUploadClient
  }) {
    this.workspaceSlug = options.workspaceSlug
    this.api = options.api ?? duetApi
    this.uploads = new DriveUploadSessions({
      workspaceSlug: options.workspaceSlug,
      api: this.api,
      ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
    })
  }

  put(
    cwd: string | undefined,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ): UploadRequest {
    return this.uploads.put(attachmentLandingPrefix({ cwd }), filename, file, onProgress)
  }

  async delete(cwd: string | undefined, filename: string): Promise<void> {
    await this.uploads.delete(attachmentLandingPrefix({ cwd }), filename)
  }

  // The name is usually free, so the probe declares the path optional rather
  // than provoking a 404 the browser would log on every attachment.
  async exists(cwd: string | undefined, filename: string): Promise<boolean> {
    const path = `${attachmentLandingPrefix({ cwd })}/${filename}`
    return (await this.api.statOptionalWorkspaceFile(this.workspaceSlug, path)) !== null
  }

  async mkdir(path: string): Promise<void> {
    await this.api.operateOnWorkspaceFiles(this.workspaceSlug, {
      operation: 'mkdir',
      path,
      recursive: true,
    })
  }

  async move(source: string, destination: string): Promise<void> {
    await this.api.operateOnWorkspaceFiles(this.workspaceSlug, {
      operation: 'move',
      source,
      destination,
      overwrite: false,
    })
  }
}
