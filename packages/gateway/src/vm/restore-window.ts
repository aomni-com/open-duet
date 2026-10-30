export interface RestoreWindow {
  inFlight(): boolean
  run<T>(restore: () => Promise<T>): Promise<T>
}

export function createRestoreWindow(): RestoreWindow {
  let activeRestores = 0
  let tail = Promise.resolve()
  return {
    inFlight: () => activeRestores > 0,
    async run(restore) {
      activeRestores += 1
      const result = tail.then(restore)
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      try {
        return await result
      } finally {
        activeRestores -= 1
      }
    },
  }
}
