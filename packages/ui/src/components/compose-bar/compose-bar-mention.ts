import Fuse from 'fuse.js'

/**
 * The grammar every composer trigger shares.
 *
 * A trigger is a character that opens a picker (`/` for skills, `@` for the
 * things that will follow), and a picked item becomes a self-closing tag the
 * agent runtime already knows how to read. Only the tag name and its attribute
 * list differ between triggers, so those are data here rather than a second
 * copy of the codec.
 */
export type MentionTagSpec = {
  /** The tag name, exactly as the agent parses it. Case is significant. */
  readonly tag: string
  /** Attribute names, in the order they are written. */
  readonly attributes: readonly string[]
}

export type MentionAttributes = Record<string, string>

export type MatchedMentionTag = { attrs: MentionAttributes; raw: string }

/**
 * Writes this spec's tag, leaving out the attributes that have no value.
 *
 * Not every item carries every attribute — an agent may have no display name
 * of its own, and the drive root has no folder — and `name=""` reads as a
 * claim that the name is empty rather than that there isn't one. Omission is
 * safe because the reader on the other side is already defined to treat an
 * absent attribute as empty, so a tag round-trips to the same item either way.
 */
export function renderMentionTag(spec: MentionTagSpec, attrs: MentionAttributes): string {
  const written = spec.attributes
    .filter(name => (attrs[name] ?? '') !== '')
    .map(name => `${name}="${escapeAttribute(attrs[name] ?? '')}"`)
    .join(' ')
  return written === '' ? `<${spec.tag} />` : `<${spec.tag} ${written} />`
}

/**
 * Reads this spec's tag at the very start of `source` — the shape a Markdown
 * tokenizer is handed.
 *
 * Attributes are read by name rather than by position, because a tag written by
 * hand (or by an older version of this codec) can order them differently and
 * still mean the same thing. An attribute the tag omits reads as empty: the
 * item is still identifiable, and refusing the whole match would turn a
 * slightly-wrong tag into literal text in the middle of someone's message.
 */
export function matchMentionTag(spec: MentionTagSpec, source: string): MatchedMentionTag | null {
  const opening = new RegExp(`^<${spec.tag}(?=[\\s/>])((?:"[^"]*"|[^>"])*)/>`).exec(source)
  if (opening === null) return null

  const attrs: MentionAttributes = {}
  for (const name of spec.attributes) {
    const found = new RegExp(`\\b${name}="([^"]*)"`).exec(opening[1] ?? '')
    attrs[name] = unescapeAttribute(found?.[1] ?? '')
  }
  return { attrs, raw: opening[0] }
}

/** Where this spec's next tag starts in `source`, or -1 — the tokenizer's scan hint. */
export function findMentionTagStart(spec: MentionTagSpec, source: string): number {
  const found = new RegExp(`<${spec.tag}(?=[\\s/>])`).exec(source)
  return found?.index ?? -1
}

/**
 * Which items a partly-typed query means, best first.
 *
 * Fuzzy, matching the sibling composer in chat-app rather than the agent's
 * terminal picker: the TUI filters on prefix alone, so `wsp` — and even `spec`
 * — find `write-spec` nowhere, and nobody types a hyphenated name in full to
 * reach it. Fuse scores a whole-string match at zero, so the literal name still
 * sorts above the longer names containing it; that guarantee is pinned by test
 * rather than assumed, because it is the case a fuzzy matcher most often gets
 * wrong.
 *
 * Typing is looser than naming, so the query is normalized first: names are
 * hyphenated, people type spaces, and capitalization never means anything in a
 * trigger.
 *
 * Each trigger names the fields it searches, and there is deliberately no
 * default: agents are findable by the slug that disambiguates two colleagues
 * sharing a display name, while skills stay name-only. A default would let a
 * later trigger widen an existing one by omission.
 */
export function rankItems<Item extends object>(
  items: readonly Item[],
  query: string,
  keys: readonly Extract<keyof Item, string>[],
  threshold?: number,
): readonly Item[] {
  const needle = normalizeForMatch(query)
  if (needle.length === 0) return items

  return new Fuse(items, { keys: [...keys], ...(threshold === undefined ? {} : { threshold }) })
    .search(needle)
    .map(result => result.item)
}

function normalizeForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}
