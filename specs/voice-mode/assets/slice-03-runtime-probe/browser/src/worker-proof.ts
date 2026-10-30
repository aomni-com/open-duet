import type { RemoteParticipant } from 'livekit-client'

type WorkerParticipant = Pick<RemoteParticipant, 'identity' | 'attributes'>

export type WorkerProof = {
  workerIdentity: string
  activationInstanceSha256: string
}

export class WorkerProofTracker {
  readonly #expectedDigest: string

  constructor(expectedDigest: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error('worker metadata digest must be lowercase SHA-256')
    }
    this.#expectedDigest = expectedDigest
  }

  observe(participant: WorkerParticipant): WorkerProof | null {
    if (participant.attributes['probe.metadata_sha256'] !== this.#expectedDigest) return null
    const activationInstanceSha256 = participant.attributes['probe.activation_sha256']
    if (!activationInstanceSha256 || !/^[a-f0-9]{64}$/.test(activationInstanceSha256)) return null
    return { workerIdentity: participant.identity, activationInstanceSha256 }
  }
}
