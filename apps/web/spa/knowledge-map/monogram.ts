/**
 * The two letters an app is known by when it ships no artwork.
 *
 * The alternative would be the same generic window icon on every one of them,
 * which tells you an app is an app and nothing else. Digits and punctuation are
 * dropped rather than shown, because "S3" reading as "S" is better than "13"
 * reading as a number.
 *
 * It sits in a file of its own, with no component in it, because both renderers
 * of it are drawn by different fixtures — the ring's SVG tile and the rail's DOM
 * one — and the visual coverage ledger walks imports rather than renders. Living
 * beside the glyphs, it would hand every glyph in that module to whichever
 * fixture happened to import this function, and claim a coverage those shots do
 * not have.
 */
export function monogram(title: string): string {
  const words = title.match(/[A-Za-z]+/g) ?? []
  if (words.length === 0) return ''
  if (words.length > 1) return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase()

  const word = words[0]!
  return `${word[0]}${word.length > 1 ? word.at(-1) : ''}`.toUpperCase()
}
