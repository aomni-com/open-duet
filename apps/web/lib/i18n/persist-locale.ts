import { serializeDuetLocaleCookie, type DuetLocale } from '@repo/web-locale'

export function persistDuetLocale(locale: DuetLocale): void {
  if (typeof document === 'undefined') return
  document.cookie = serializeDuetLocaleCookie(locale, window.location.hostname)
}
