'use client'

import './markdown.css'

import {
  Children,
  isValidElement,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { cn } from '@repo/ui/lib/utils'

const markdownClassName =
  'ui-markdown prose max-w-none break-words dark:prose-invert prose-p:leading-normal prose-a:no-underline prose-pre:p-0 max-w-full'

// Component types must be render-stable: react-markdown re-parses on every
// text change (e.g. while a message streams), and an inline-arrow component
// is a new type each render, which makes React remount the whole subtree —
// resetting media playback inside a paragraph. Defaults live at module scope
// (or in a memo keyed on their real inputs) so reconciliation preserves DOM
// nodes across re-renders.

// Paragraphs preserve authored newlines. react-markdown leaves a newline text
// node after an explicit <br>; keeping both would render two breaks under
// white-space: pre-wrap, so consume the redundant text newline.
function DefaultParagraph({
  node: _,
  children,
  ...props
}: ComponentPropsWithoutRef<'p'> & { node?: unknown }) {
  const content = Children.toArray(children).map((child, index, siblings) => {
    const previous = siblings[index - 1]
    if (
      typeof child !== 'string' ||
      !child.startsWith('\n') ||
      !isValidElement(previous) ||
      previous.type !== 'br'
    )
      return child
    return child.slice(1)
  })
  return (
    <p {...props} className="last:!mb-0 whitespace-pre-wrap break-words">
      {content}
    </p>
  )
}

function createDefaultAnchor(onLinkClicked?: (href: string) => void) {
  return function DefaultAnchor({
    node: _,
    ...rest
  }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
    return (
      <a
        target="_blank"
        {...rest}
        onClick={e => {
          if (onLinkClicked) {
            e.preventDefault()
            if (rest.href) {
              onLinkClicked(rest.href)
            }
          }
        }}
      />
    )
  }
}

// NOTE: the default markdown component is meant to be used on client side, due to use of onLinkClicked
export function Markdown({
  children,
  onLinkClicked,
  className,
  components,
}: {
  children: ReactNode
  onLinkClicked?(href: string): void
  className?: string
  components?: Partial<Components>
}) {
  const mergedComponents = useMemo(
    () => ({
      a: createDefaultAnchor(onLinkClicked),
      p: DefaultParagraph,
      ...components,
    }),
    [onLinkClicked, components],
  )

  if (typeof children !== 'string' || typeof children === 'undefined') {
    return null
  }

  return (
    <ReactMarkdown
      className={cn(markdownClassName, className)}
      skipHtml
      remarkPlugins={[remarkGfm, remarkMath]}
      components={mergedComponents}
    >
      {children}
    </ReactMarkdown>
  )
}
