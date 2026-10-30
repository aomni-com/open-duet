import { serializeDuetLocaleCookie, type DuetLocale } from '@repo/web-locale'

export function persistDuetLocale(locale: DuetLocale): void {
  document.cookie = serializeDuetLocaleCookie(locale, window.location.hostname)
}
