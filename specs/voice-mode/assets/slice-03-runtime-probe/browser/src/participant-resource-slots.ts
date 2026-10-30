type ResourceSlot<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
  settled: boolean
}

export class ParticipantResourceSlots<T> {
  readonly #slots = new Map<string, ResourceSlot<T>>()

  wait(identity: string): Promise<T> {
    return this.#slot(identity).promise
  }

  resolve(identity: string, value: T): void {
    const slot = this.#slot(identity)
    if (slot.settled) return
    slot.settled = true
    slot.resolve(value)
  }

  reject(identity: string, error: Error): void {
    const slot = this.#slot(identity)
    if (slot.settled) return
    slot.settled = true
    slot.reject(error)
  }

  clear(): void {
    this.#slots.clear()
  }

  #slot(identity: string): ResourceSlot<T> {
    const existing = this.#slots.get(identity)
    if (existing) return existing
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const created = { promise, resolve, reject, settled: false }
    this.#slots.set(identity, created)
    return created
  }
}
