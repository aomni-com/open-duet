/**
 * One-shot client-side browser locale detection.
 *
 * Renders an inline `<script>` in <head> that runs once per browser
 * session, before any React code hydrates. If the visitor:
 *   - has no DUET_LOCALE cookie yet (i.e. has never picked a language)
 *   - is on a page that advertises a Spanish alternate
 *   - has `navigator.language` starting with "es"
 * …then the script writes `DUET_LOCALE=es-419` and redirects to the
 * `/es`-prefixed equivalent so the visitor sees Spanish on first load.
 *
 * Inline (not `<Script>`) so it runs before any paint. The work is
 * gated by `sessionStorage` so it never runs twice in the same session,
 * which avoids redirect loops if the cookie write somehow doesn't stick.
 *
 * English-only and preserved routes do not emit a Spanish alternate, so the
 * cookie still carries into the SPA without inventing a nonexistent `/es/*`
 * URL. This keeps the redirect rule coupled to the same hreflang contract SEO
 * already uses instead of maintaining a second route allowlist here.
 *
 * The script is intentionally tiny + dependency-free so it stays
 * compatible with the static root layout.
 */
import { DUET_LOCALE_COOKIE, serializeDuetLocaleCookie } from '@repo/web-locale'

import { resolveConfiguredLanderOrigin } from '@/src/config/origins'

const localeCookieHostname = new URL(resolveConfiguredLanderOrigin()).hostname
const spanishCookie = serializeDuetLocaleCookie('es-419', localeCookieHostname)

const DETECT_SCRIPT = `
(function(){
  try {
    if (sessionStorage.getItem('locale-detected')) return;
    sessionStorage.setItem('locale-detected', '1');
    if (document.cookie.indexOf(${JSON.stringify(`${DUET_LOCALE_COOKIE}=`)}) !== -1) return;
    var lang = (navigator.language || '').toLowerCase();
    if (lang.indexOf('es') !== 0) return;
    document.cookie = ${JSON.stringify(spanishCookie)};
    var path = location.pathname;
    if (path.indexOf('/es') === 0) return;
    var alternate = document.querySelector('link[rel="alternate"][hreflang="es"]');
    if (!alternate) return;
    var target = new URL(alternate.href, location.href);
    location.replace(target.pathname + location.search + location.hash);
  } catch (e) {}
})();
`.trim()

export function LocaleAutoDetect() {
  return (
    <script
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: DETECT_SCRIPT }}
    />
  )
}
