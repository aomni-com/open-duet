/**
 * One cut, shared by everything that prints a fragment of what somebody wrote.
 *
 * A leaf on purpose. The session title reads it from `./index` and the chat
 * preview reads it from `./message-preview`; if the two reached it through each
 * other this folder would hold an import cycle, whose failure mode is a schema
 * that is `undefined` at module-evaluation time rather than an error anyone can
 * read.
 */

/**
 * Collapse the whitespace, then cut on a width the reader can see.
 *
 * The ellipsis is spent out of the budget rather than added to it, so
 * `maxLength` is the width of what is drawn and never a number the caller has
 * to adjust for.
 */
export function excerpt(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

/** What a message carried, for the places that name a message without words. */
export type SentMedia = {
  attachments?: readonly { name: string }[]
  images?: readonly unknown[]
}

/**
 * The files a message carried, as the words it did not have: their names, or
 * for pasted images, which have none, how many there were. Empty when it
 * carried nothing.
 */
export function sentMediaLabel(media: SentMedia): string {
  const names = media.attachments?.map(attachment => attachment.name) ?? []
  if (names.length > 0) return names.join(', ')
  const images = media.images?.length ?? 0
  if (images === 0) return ''
  return images === 1 ? 'Image' : `${images} images`
}
