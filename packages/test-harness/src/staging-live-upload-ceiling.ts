/* ============================================================================
   Who refuses an oversize upload, asked without sending one.

   A body cap that rejects on the declared `Content-Length` answers before any
   bytes are sent — which is the bug that started this work, and here it is the
   thing that makes the question cheap. Send the request head alone and read who
   answers.

   Three answers are possible and they mean different things:

   - the gateway refused, with its typed body and CORS headers — the limit is
     ours, it is readable, and the declaration crossed the edge proxy untouched;
   - something in front refused, with a 413 that is not ours — exe.dev's proxy
     has a ceiling of its own, which is the open question this exists to answer;
   - nobody answered inside the window — the declaration was admitted and the
     server is waiting for a body that will never come.

   The last one is a pass, not a timeout failure.
   ========================================================================= */
import { connect } from 'node:tls'

import { FILE_TOO_LARGE_ERROR } from '@repo/contract'

export type UploadCeilingProbe =
  | { kind: 'answered'; declaredBytes: number; status: number; head: string; elapsedMs: number }
  | { kind: 'no-answer'; declaredBytes: number; elapsedMs: number }

export type UploadCeilingVerdict = 'gateway-refused' | 'refused-in-front' | 'admitted'

/**
 * What the raw response says about who owns the refusal.
 *
 * Pure, so its truth table costs nothing to test — the live probe is expensive
 * and rare, and this is the part that could be wrong.
 */
export function classifyUploadCeilingProbe(probe: UploadCeilingProbe): UploadCeilingVerdict {
  if (probe.kind === 'no-answer') return 'admitted'
  const head = probe.head.toLowerCase()
  const ours = head.includes(FILE_TOO_LARGE_ERROR) && head.includes('access-control-allow-origin')
  return ours ? 'gateway-refused' : 'refused-in-front'
}

/**
 * Send one request head with a declared length and no body at all.
 *
 * Deliberately not `fetch`: a declared `Content-Length` with no payload is not
 * a request any HTTP client will make for you, and sending the payload is the
 * one thing this must never do.
 */
export async function probeDeclaredBodyCeiling(input: {
  vmBaseUrl: string
  uploadPath: string
  uploadToken: string
  filename: string
  declaredBytes: number
  timeoutMs: number
}): Promise<UploadCeilingProbe> {
  const url = new URL(input.vmBaseUrl)
  const startedAt = Date.now()
  const chunks: Buffer[] = []

  return await new Promise<UploadCeilingProbe>((resolve, reject) => {
    let declarationSent = false
    const socket = connect(
      { host: url.hostname, port: Number(url.port || 443), servername: url.hostname },
      () => {
        socket.write(
          [
            `PUT ${input.uploadPath}/${encodeURIComponent(input.filename)} HTTP/1.1`,
            `Host: ${url.hostname}`,
            `Authorization: Bearer ${input.uploadToken}`,
            'Origin: https://app-staging.duet.so',
            `Content-Length: ${input.declaredBytes}`,
            'Content-Type: application/octet-stream',
            '',
            '',
          ].join('\r\n'),
        )
        declarationSent = true
      },
    )

    const settle = (probe: UploadCeilingProbe) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(probe)
    }
    const timer = setTimeout(() => {
      if (!declarationSent) {
        socket.destroy()
        reject(new Error('Upload declaration was not delivered before the probe deadline'))
        return
      }
      settle({
        kind: 'no-answer',
        declaredBytes: input.declaredBytes,
        elapsedMs: Date.now() - startedAt,
      })
    }, input.timeoutMs)

    socket.on('data', chunk => {
      chunks.push(chunk as Buffer)
      const head = Buffer.concat(chunks).toString('utf8')
      if (!head.includes('\r\n\r\n')) return
      settle({
        kind: 'answered',
        declaredBytes: input.declaredBytes,
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0),
        head,
        elapsedMs: Date.now() - startedAt,
      })
    })
    socket.on('error', error => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}
