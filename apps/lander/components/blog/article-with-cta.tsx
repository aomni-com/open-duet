'use client'

import { useRef } from 'react'

import type { CtaCopy } from '@/lib/blog/types'

import { DuetCTA } from './duet-cta'
import { InlineCTAInjector } from './inline-cta-injector'

/**
 * Article body wrapper that injects a `DuetCTA` mid-article (before the
 * Nth h2). The `cta` prop comes from the post's frontmatter `cta` field
 * and overrides each piece of copy independently — anything missing
 * falls back to the generic copy below. Authors are strongly encouraged
 * to supply post-specific copy: "Run your books with Duet" beats
 * "Run this in your own business" on every metric.
 */
export function ArticleWithCTA({ children, cta }: { children: React.ReactNode; cta?: CtaCopy }) {
  const articleRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <div ref={articleRef} className="prose prose-lg max-w-none dark:prose-invert">
        {children}
      </div>
      <InlineCTAInjector articleRef={articleRef} afterHeading={3}>
        <DuetCTA
          className="my-10"
          title={cta?.title}
          subtitle={cta?.subtitle}
          buttonText={cta?.buttonText}
          href={cta?.href}
        />
      </InlineCTAInjector>
    </>
  )
}
