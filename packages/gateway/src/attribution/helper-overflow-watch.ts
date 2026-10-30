export interface HelperOverflowWatch {
  observe(total: number): void
  reset(): void
}

/** Tracks one helper process's cumulative FAN overflow counter. */
export function createHelperOverflowWatch(onIncrease: () => void): HelperOverflowWatch {
  let previous = 0
  return {
    observe(total) {
      if (total > previous) onIncrease()
      previous = total
    },
    reset() {
      previous = 0
    },
  }
}
