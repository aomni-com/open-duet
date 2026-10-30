import {
  AGENT_TAG,
  findMentionTagStart,
  matchMentionTag,
  SKILL_TAG,
  type MentionTagSpec,
} from '@repo/ui/components/compose-bar'

/**
 * How a mention chip travels between this transform and the renderer's anchor
 * override.
 *
 * Fragments rather than a custom `duet-skill:` scheme: the Markdown renderer
 * sanitizes URLs and blanks any protocol it does not recognize, which silently
 * turned the chip back into an ordinary empty link. Fragments survive that
 * sanitizer, and the anchor override decides what each one renders as.
 */
export const SKILL_CHIP_SCHEME = '#duet-skill='
export const AGENT_CHIP_SCHEME = '#duet-agent='

/**
 * Turn the mention tags in a message into something the renderer can draw.
 *
 * The message renderer drops raw HTML rather than escaping it — a deliberate
 * safety choice for agent output that must not be relaxed for this — so a tag
 * would otherwise vanish with no trace that a skill was invoked or a colleague
 * named. Rewriting each as a link with a reserved scheme keeps the transform
 * inside Markdown, where the existing anchor override can render the chip the
 * composer showed.
 *
 * Both directions go through here: the same call site renders the sender's own
 * message and an agent's reply, so an agent that names a colleague gets the
 * same chip the sender would have.
 *
 * Code stays code: a message *about* a tag — someone asking how to invoke a
 * skill, or an agent quoting the grammar back — must survive verbatim, so
 * fenced blocks and inline spans are copied through untouched.
 */
export function withMentionChips(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .map(line => {
      if (line.trimStart().startsWith('```')) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      // Split on *closed* code spans rather than on backticks: counting
      // backticks and taking every other segment as prose flips parity on an
      // unmatched one, and everything after a stray backtick would be treated
      // as code — suppressing a chip in ordinary prose. An unmatched backtick
      // is not a code span, so it stays in a prose segment where it belongs.
      return line
        .split(/(`[^`]*`)/)
        .map(segment => (segment.startsWith('`') ? segment : replaceTags(segment)))
        .join('')
    })
    .join('\n')
}

/** One tag spec and the link a match of it becomes. */
const CHIP_KINDS: readonly {
  spec: MentionTagSpec
  scheme: string
  label: (attrs: Record<string, string>) => string
  target: (attrs: Record<string, string>) => string
}[] = [
  {
    spec: SKILL_TAG,
    scheme: SKILL_CHIP_SCHEME,
    label: attrs => `/${attrs.name ?? ''}`,
    target: attrs => attrs.name ?? '',
  },
  {
    spec: AGENT_TAG,
    scheme: AGENT_CHIP_SCHEME,
    // The name the sender saw, falling back to the slug for an agent that has
    // none. The slug is what the link carries either way.
    label: attrs => `@${attrs.name || attrs.slug || ''}`,
    target: attrs => attrs.slug ?? '',
  },
]

function replaceTags(segment: string): string {
  let out = ''
  let rest = segment
  for (;;) {
    const next = nextTag(rest)
    if (next === null) break
    if (next.matched === null) {
      // A tag opening that closes nothing is ordinary text; step past the angle
      // bracket so the scan cannot stall on it.
      out += rest.slice(0, next.at + 1)
      rest = rest.slice(next.at + 1)
      continue
    }
    const attrs = next.matched.attrs
    out +=
      rest.slice(0, next.at) +
      `[${escapeLinkText(next.kind.label(attrs))}](${next.kind.scheme}${encodeURIComponent(
        next.kind.target(attrs),
      )})`
    rest = rest.slice(next.at + next.matched.raw.length)
  }
  return out + rest
}

/** The earliest tag of any kind in `rest`, so one scan serves every spec. */
function nextTag(rest: string) {
  let found: {
    at: number
    kind: (typeof CHIP_KINDS)[number]
    matched: ReturnType<typeof matchMentionTag>
  } | null = null

  for (const kind of CHIP_KINDS) {
    const at = findMentionTagStart(kind.spec, rest)
    if (at === -1) continue
    if (found !== null && found.at <= at) continue
    found = { at, kind, matched: matchMentionTag(kind.spec, rest.slice(at)) }
  }
  return found
}

/**
 * A label sits inside `[...]`, so a bracket in it would end the link early.
 * Agent names are restricted at the schema, but a name stored before that rule
 * existed still has to render as text rather than as broken Markdown.
 */
function escapeLinkText(value: string): string {
  return value.replace(/([[\]])/g, '\\$1')
}

/** The skill name a chip link carries, or null for an ordinary link. */
export function skillChipName(href: string): string | null {
  if (!href.startsWith(SKILL_CHIP_SCHEME)) return null
  return decodeURIComponent(href.slice(SKILL_CHIP_SCHEME.length))
}

/** The agent slug a chip link carries, or null for an ordinary link. */
export function agentChipSlug(href: string): string | null {
  if (!href.startsWith(AGENT_CHIP_SCHEME)) return null
  return decodeURIComponent(href.slice(AGENT_CHIP_SCHEME.length))
}
