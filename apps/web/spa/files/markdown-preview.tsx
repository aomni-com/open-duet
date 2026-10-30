'use client'

import { Markdown } from '@repo/ui/components/common/markdown'

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl p-4 md:p-7">
      <Markdown>{content}</Markdown>
    </div>
  )
}
