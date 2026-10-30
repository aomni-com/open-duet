import { vmUploadUrl, type VmUploadGrant as ContractVmUploadGrant } from '@repo/contract'

import { DuetApiError } from './client'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type XhrFactory = () => XMLHttpRequest

export type VmUploadGrant = ContractVmUploadGrant & {
  requestHeaders?: Readonly<Record<string, string>>
}

export interface UploadRequest {
  done: Promise<void>
  abort(): void
}

export class VmUploadError extends Error {
  override readonly name = 'VmUploadError'

  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}

/**
 * What code did this upload fail with?
 *
 * An upload can fail at either end of two different rails — the API answers
 * with `DuetApiError`, the VM itself with `VmUploadError` — and both carry the
 * reason as a plain `code` string. So the reason is read off the field rather
 * than off the class, and an error carrying none is simply uncoded.
 *
 * The code has to *be* a string: `DOMException` — how an aborted upload
 * arrives — carries a legacy numeric `code` that means something else entirely,
 * and reading it would answer `"20"` to a question about upload reasons.
 */
export function uploadErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * The HTTP status behind a coded failure, when there was a response at all.
 *
 * Unlike the code, a status is only meaningful on the two errors that were
 * built from a real response — anything else shaped like one is a fake or a
 * coincidence, and answering for it would let a code be trusted without the
 * status that qualifies it.
 */
export function uploadErrorStatus(error: unknown): number | undefined {
  return error instanceof VmUploadError || error instanceof DuetApiError ? error.status : undefined
}

export class VmUploadClient {
  private readonly fetchImpl: FetchLike
  private readonly createXhr: XhrFactory
  private readonly now: () => number
  private readonly sessions = new WeakMap<() => Promise<VmUploadGrant>, VmUploadGrant>()
  private readonly pendingSessions = new WeakMap<
    () => Promise<VmUploadGrant>,
    Promise<VmUploadGrant>
  >()

  constructor(options: { fetch?: FetchLike; createXhr?: XhrFactory; now?: () => number } = {}) {
    // Calling a bare reference to the browser's global fetch with a client as
    // `this` fails its brand check before a request leaves the page.
    const fetchImpl = options.fetch ?? fetch
    this.fetchImpl = (input, init) => fetchImpl(input, init)
    this.createXhr = options.createXhr ?? (() => new XMLHttpRequest())
    this.now = options.now ?? Date.now
  }

  async session<Grant extends VmUploadGrant>(mint: () => Promise<Grant>): Promise<Grant> {
    const existing = this.sessions.get(mint)
    if (existing && existing.expiresAt - this.now() > 30_000) return existing as Grant
    const pending = this.pendingSessions.get(mint)
    if (pending) return (await pending) as Grant
    const request = mint()
    this.pendingSessions.set(mint, request)
    try {
      const grant = await request
      this.sessions.set(mint, grant)
      return grant
    } finally {
      this.pendingSessions.delete(mint)
    }
  }

  put(
    grant: VmUploadGrant,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ): UploadRequest {
    const xhr = this.createXhr()
    const done = new Promise<void>((resolve, reject) => {
      xhr.open('PUT', vmUploadUrl(grant, filename))
      setGrantHeaders(xhr, grant)
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
        }
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else reject(xhrError(xhr))
      }
      xhr.onerror = () => reject(new VmUploadError(0, 'network_error'))
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
      xhr.send(file)
    })
    return { done, abort: () => xhr.abort() }
  }

  putFromSession(
    mint: () => Promise<VmUploadGrant>,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ): UploadRequest {
    let request: UploadRequest | undefined
    let aborted = false
    const done = (async () => {
      const grant = await this.session(mint)
      if (aborted) throw new DOMException('Upload aborted', 'AbortError')
      request = this.put(grant, filename, file, onProgress)
      await request.done
    })()
    return {
      done,
      abort: () => {
        aborted = true
        request?.abort()
      },
    }
  }

  async delete(grant: VmUploadGrant, filename: string): Promise<void> {
    const headers = new Headers({ Authorization: `Bearer ${grant.uploadToken}` })
    for (const [name, value] of Object.entries(grant.requestHeaders ?? {})) headers.set(name, value)
    const response = await this.fetchImpl(vmUploadUrl(grant, filename), {
      method: 'DELETE',
      headers,
    })
    if (!response.ok) throw await responseError(response)
  }
}

function setGrantHeaders(xhr: XMLHttpRequest, grant: VmUploadGrant): void {
  xhr.setRequestHeader('Authorization', `Bearer ${grant.uploadToken}`)
  for (const [name, value] of Object.entries(grant.requestHeaders ?? {})) {
    xhr.setRequestHeader(name, value)
  }
}

function xhrError(xhr: XMLHttpRequest): VmUploadError {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: string; message?: string }
    return new VmUploadError(xhr.status, payload.error ?? 'request_failed', payload.message)
  } catch {
    return new VmUploadError(xhr.status, 'request_failed')
  }
}

async function responseError(response: Response): Promise<VmUploadError> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string; detail?: string }
    return new VmUploadError(
      response.status,
      payload.error ?? 'request_failed',
      payload.message ?? payload.detail,
    )
  } catch {
    return new VmUploadError(response.status, 'request_failed')
  }
}
