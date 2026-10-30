import { z } from 'zod'

/**
 * Permission to upload files straight to a workspace VM, bypassing the API.
 *
 * Raw upload bytes never pass through the public API: a training inbox holds up
 * to `TRAIN_UPLOADS_CAP_BYTES`, orders of magnitude more than any request body
 * the API accepts. So the API mints this grant and the client sends the bytes
 * to the VM itself.
 *
 * `vmBaseUrl` is the VM's portless public proxy URL (exe.dev `share
 * set-public`). `uploadToken` is the ONLY credential that request carries — no
 * edge token, because a browser's CORS preflight cannot carry one — which is
 * why it is short-lived and why `expiresAt` says when to mint another.
 *
 * `uploadPath` is a path, not a URL: one grant covers many files, so the target
 * is built per file. Use `vmUploadUrl` rather than joining it by hand.
 */
export const VmUploadGrantSchema = z.object({
  vmBaseUrl: z.url(),
  uploadPath: z.string().min(1),
  uploadToken: z.string().min(1),
  expiresAt: z.number(),
})

export type VmUploadGrant = z.infer<typeof VmUploadGrantSchema>

/**
 * Where to `PUT` one file's bytes, given a grant.
 *
 * The filename is a single path segment and is encoded as one, so a name
 * containing a separator, a space, or a query character addresses a file rather
 * than retargeting the request.
 */
export function vmUploadUrl(grant: VmUploadGrant, filename: string): string {
  const base = grant.vmBaseUrl.endsWith('/') ? grant.vmBaseUrl : `${grant.vmBaseUrl}/`
  return new URL(`${grant.uploadPath}/${encodeURIComponent(filename)}`, base).toString()
}
