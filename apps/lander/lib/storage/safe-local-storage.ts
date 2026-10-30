'use client'

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function getStorageItem(key: string): string | null {
  try {
    return localStorageOrNull()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function setStorageItem(key: string, value: string): void {
  try {
    localStorageOrNull()?.setItem(key, value)
  } catch {
    // Email capture remains usable when storage is unavailable or full.
  }
}
