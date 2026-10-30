'use client'

import {
  Extension,
  mergeAttributes,
  type Extensions,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
} from '@tiptap/core'
import Mention from '@tiptap/extension-mention'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'

import {
  findMentionTagStart,
  matchMentionTag,
  rankItems,
  renderMentionTag,
  type MentionAttributes,
  type MentionTagSpec,
} from './compose-bar-mention'
import {
  firstEligibleIndex,
  isEligibleIndex,
  stepEligibleIndex,
} from './compose-bar-suggestion-rows'

/** What a picker row needs to draw itself, whatever the trigger is. */
export type ComposeBarSuggestionItem = {
  /**
   * Stable row identity. Deliberately not the name: display names are not
   * unique — two agents may answer to the same one — so keying rows by name
   * collapses them into each other.
   */
  id: string
  name: string
  description?: string
  /** Short qualifier beside the name — a skill's scope, a file's folder. */
  scopeLabel?: string
  /** Listed, but not selectable: shown so its absence is not mistaken for missing. */
  disabled?: boolean
  /** Why it cannot be picked, already in the reader's language. */
  disabledLabel?: string
}

/**
 * One composer trigger: a character that opens a picker, and the tag a picked
 * item becomes.
 *
 * Everything that differs between `/skills` and the `@` triggers to come is a
 * field here, so adding one is a value rather than a second copy of the
 * suggestion plumbing.
 */
export type ComposeBarTrigger<Item extends ComposeBarSuggestionItem = ComposeBarSuggestionItem> = {
  /** ProseMirror node name. Unique per trigger — it keys the schema. */
  readonly node: string
  readonly char: string
  readonly tag: MentionTagSpec
  /** Which item fields a typed query searches. Stated per trigger; no default. */
  readonly searchKeys: readonly Extract<keyof Item, string>[]
  /**
   * How loose a match may be, 0 exact to 1 anything. Omit to inherit the
   * matcher's default, which suits names people type in full.
   */
  readonly searchThreshold?: number
  /** Read at suggestion time, so items arriving after the editor was built still appear. */
  getItems: () => readonly Item[]
  toAttributes: (item: Item) => MentionAttributes
  /** The chip's text, e.g. `/review`. */
  toLabel: (attrs: MentionAttributes) => string
  /** Fired when this trigger's picker opens — the consumer's cue to refresh. */
  onOpen?: () => void
}

/**
 * What the composer is showing while a trigger is open, published to React.
 *
 * The suggestion plugin lives in ProseMirror and the picker lives in React, so
 * exactly one of them owns the selection: this state. The plugin owns it
 * because the arrow keys arrive there first, and it hands React a rendered
 * snapshot rather than a controller.
 */
export type ComposeBarSuggestion = {
  /** Which trigger is open, so a picker can vary its glyph and labels. */
  trigger: string
  /** The character that opened it, written before each row's name. */
  char: string
  query: string
  items: readonly ComposeBarSuggestionItem[]
  /** `null` when no listed row can be picked — not the same as an empty list. */
  activeIndex: number | null
  select: (index: number) => void
}

/**
 * Widen one trigger so triggers of different item types can share a list.
 *
 * A trigger both produces its items and consumes them, so it is invariant in
 * `Item` and a `/skills` trigger is not assignable alongside an `@files` one —
 * even though each is internally consistent, which is the only thing that
 * matters here: the items a trigger hands to `toAttributes` are always the ones
 * its own `getItems` returned. Erasing the type once, here, keeps that reasoning
 * in a single named place instead of a cast at every definition.
 */
export function defineTrigger<Item extends ComposeBarSuggestionItem>(
  trigger: ComposeBarTrigger<Item>,
): ComposeBarTrigger {
  return trigger as unknown as ComposeBarTrigger
}

export interface MentionExtensionOptions {
  triggers: readonly ComposeBarTrigger[]
  onSuggestionChange: (suggestion: ComposeBarSuggestion | null) => void
}

// Enough to scroll through, short enough that the popup never becomes the page.
const MAX_SUGGESTIONS = 20

/**
 * The nodes and suggestion plugins for every trigger, plus the one Markdown
 * bridge they share.
 *
 * The bridge is shared by necessity, not by taste: Markdown hands a bare
 * `<Tag …/>` back as a raw `html` token, and an extension can only claim that
 * token name once. A bridge per trigger would leave the last one registered
 * owning every tag, so a `@` chip would come back from a saved draft as an
 * unparsed `/` chip — or as literal tag text. One bridge, trying each trigger's
 * spec in turn, is what makes a second trigger safe to add.
 */
export function createMentionExtensions(options: MentionExtensionOptions): Extensions {
  const nodes = options.triggers.map(trigger => createTriggerNode(trigger, options))
  return [...nodes, createMarkdownBridge(options.triggers)]
}

function createTriggerNode(trigger: ComposeBarTrigger, options: MentionExtensionOptions) {
  let activeIndex: number | null = null
  let items: readonly ComposeBarSuggestionItem[] = []
  let query = ''
  let command: ((item: ComposeBarSuggestionItem) => void) | null = null

  const publish = () => {
    if (command === null) {
      options.onSuggestionChange(null)
      return
    }
    options.onSuggestionChange({
      trigger: trigger.node,
      char: trigger.char,
      query,
      items,
      activeIndex,
      select: (index: number) => {
        // The same eligibility rule the keyboard obeys: a click cannot reach a
        // row the arrows refuse to land on.
        if (!isEligibleIndex(items, index)) return
        const item = items[index]
        if (item !== undefined) command?.(item)
      },
    })
  }

  const close = () => {
    command = null
    items = []
    query = ''
    activeIndex = null
    options.onSuggestionChange(null)
  }

  const accept = (props: SuggestionProps<ComposeBarSuggestionItem>) => {
    // A typed word that names nothing is prose, not a half-finished pick, so
    // the picker gets out of the way: `@sarah` in an ordinary sentence must
    // leave Enter meaning "send". Staying open would hold Enter hostage — the
    // composer's send shortcut stands down for any open picker — and would
    // show an empty-list message about a roster that is not empty.
    if (props.query.length > 0 && props.items.length === 0) {
      close()
      return
    }
    query = props.query
    items = props.items
    // A narrowing query can strand the highlight past the end of the list, or
    // on a row that is no longer selectable; either way the highlight rehomes
    // to the first row that can actually be picked.
    activeIndex = isEligibleIndex(props.items, activeIndex)
      ? activeIndex
      : firstEligibleIndex(props.items)
    command = item => props.command(item)
    publish()
  }

  return Mention.extend({
    name: trigger.node,
    markdownTokenName: trigger.node,

    addAttributes() {
      return Object.fromEntries(
        trigger.tag.attributes.map(name => [
          name,
          {
            default: '',
            parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? '',
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes[name] ? { [`data-${name}`]: attributes[name] as string } : {},
          },
        ]),
      )
    },

    renderHTML({ node, HTMLAttributes }) {
      return [
        'span',
        mergeAttributes(
          { 'data-compose-bar-mention': trigger.node },
          this.options.HTMLAttributes,
          HTMLAttributes,
        ),
        trigger.toLabel(node.attrs as MentionAttributes),
      ]
    },

    renderText({ node }) {
      return trigger.toLabel(node.attrs as MentionAttributes)
    },

    renderMarkdown: (node: JSONContent) =>
      renderMentionTag(trigger.tag, (node.attrs ?? {}) as MentionAttributes),

    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
      parseTriggerMarkdown([trigger], token, helpers),

    markdownTokenizer: {
      name: trigger.node,
      level: 'inline' as const,
      start: (source: string) => findMentionTagStart(trigger.tag, source),
      tokenize: (source: string) => tokenizeTag(trigger, source) ?? undefined,
    },
  }).configure({
    suggestion: {
      char: trigger.char,
      // The picker lists what exists, not a text search, so an unmatched query
      // closes it and leaves the typed word as prose.
      items: ({ query: typed }: { query: string }) =>
        rankItems(trigger.getItems(), typed, trigger.searchKeys, trigger.searchThreshold).slice(
          0,
          MAX_SUGGESTIONS,
        ),
      command: ({ editor, range, props }) => {
        const item = props as unknown as ComposeBarSuggestionItem
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: trigger.node, attrs: trigger.toAttributes(item) },
            // A trailing space so the next word is prose, not more of the
            // command — and so the trigger can open the picker again.
            { type: 'text', text: ' ' },
          ])
          .run()
      },
      render: () => ({
        onStart: (props: SuggestionProps<ComposeBarSuggestionItem>) => {
          activeIndex = null
          accept(props)
          trigger.onOpen?.()
        },
        onUpdate: (props: SuggestionProps<ComposeBarSuggestionItem>) => accept(props),
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          if (command === null) return false
          if (event.key === 'Escape') {
            close()
            return true
          }
          if (items.length === 0) return false
          if (event.key === 'ArrowUp') {
            activeIndex = stepEligibleIndex(items, activeIndex, -1)
            publish()
            return true
          }
          if (event.key === 'ArrowDown') {
            activeIndex = stepEligibleIndex(items, activeIndex, 1)
            publish()
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            // Consumed even when nothing can be committed. The composer's own
            // Enter shortcut stands down while a picker is open, so returning
            // false here would send the half-typed message instead of doing
            // nothing — the surprise this branch exists to prevent.
            event.preventDefault()
            const item = activeIndex === null ? undefined : items[activeIndex]
            if (item !== undefined) command(item)
            return true
          }
          return false
        },
        onExit: () => close(),
      }),
    },
  })
}

function createMarkdownBridge(triggers: readonly ComposeBarTrigger[]) {
  return Extension.create({
    name: 'composeBarMentionMarkdownBridge',
    markdownTokenName: 'html',
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
      parseTriggerMarkdown(triggers, token, helpers),
  })
}

type TagToken = MarkdownToken & { raw?: unknown; text?: unknown; attributes?: unknown }

function tokenizeTag(trigger: ComposeBarTrigger, source: string): TagToken | null {
  const matched = matchMentionTag(trigger.tag, source)
  if (matched === null) return null
  return { type: trigger.node, raw: matched.raw, attributes: matched.attrs }
}

function parseTriggerMarkdown(
  triggers: readonly ComposeBarTrigger[],
  token: MarkdownToken,
  helpers: MarkdownParseHelpers,
) {
  const typed = token as TagToken
  for (const trigger of triggers) {
    if (typed.type === trigger.node && typed.attributes !== undefined) {
      return helpers.createNode(trigger.node, typed.attributes as MentionAttributes)
    }
    const matched = matchMentionTag(trigger.tag, rawTokenText(typed))
    if (matched !== null) return helpers.createNode(trigger.node, matched.attrs)
  }
  return helpers.createNode('text', {})
}

function rawTokenText(token: TagToken): string {
  if (typeof token.raw === 'string' && token.raw.length > 0) return token.raw
  return typeof token.text === 'string' ? token.text : ''
}
