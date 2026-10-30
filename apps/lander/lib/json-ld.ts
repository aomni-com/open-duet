/**
 * JSON-LD payload escaper.
 *
 * Next.js docs explicitly call this out for `<script type="application/ld+json">`
 * tags that ship via `dangerouslySetInnerHTML`: replace every `<` with the
 * unicode escape `\u003c` so a future schema value containing the literal
 * substring `</script>` can never close the surrounding script element.
 *
 * Today every JSON-LD payload on the site is built from static spec data, so
 * the risk is theoretical \u2014 but routing every payload through this helper
 * means the moment any user-supplied or CMS-supplied string lands in a
 * schema field, the site is already hardened.
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
