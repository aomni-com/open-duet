'use client'

import React, { useState } from 'react'

import { BetaBadge } from '@repo/ui/components/common/beta-badge'
import { Markdown } from '@repo/ui/components/common/markdown'
import { PrettyObject } from '@repo/ui/components/common/pretty-object'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

export function ContentDisplayDemos() {
  const [markdownContent, setMarkdownContent] = useState(`# Sample Markdown

This is a **bold** text and this is *italic*.

## Features
- Lists work great
- [Links](https://example.com) are clickable
- \`Code snippets\` are highlighted

### Code Block
\`\`\`javascript
function hello() {
  console.log("Hello, world!");
}
\`\`\`

> This is a blockquote with some important information.

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |
| More     | Data     | Here     |
`)

  const sampleData = {
    user: {
      id: 123,
      name: 'John Doe',
      email: 'john@example.com',
      website: 'https://johndoe.com',
      preferences: {
        theme: 'dark',
        notifications: true,
        language: 'en',
      },
      tags: ['developer', 'designer', 'manager'],
      metadata: {},
    },
    stats: {
      totalUsers: 1250,
      activeUsers: 892,
      conversionRate: 0.234,
    },
    urls: ['https://example.com', 'https://github.com/user/repo', 'https://docs.example.com'],
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Markdown Component</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h4 className="text-sm font-medium mb-2">Input:</h4>
            <textarea
              value={markdownContent}
              onChange={e => setMarkdownContent(e.target.value)}
              className="min-h-[40rem] w-full rounded-md border p-3 font-mono text-sm"
              placeholder="Enter markdown content..."
            />
          </div>
          <div>
            <h4 className="text-sm font-medium mb-2">Rendered Output:</h4>
            <div className="min-h-[26rem] rounded-md border bg-muted/20 p-4">
              <Markdown onLinkClicked={(href: string) => alert(`Link clicked: ${href}`)}>
                {markdownContent}
              </Markdown>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Pretty Object</h3>
        <div className="max-w-2xl">
          <h4 className="text-sm font-medium mb-2">Complex Object Rendering:</h4>
          <div className="border rounded-md p-4 bg-muted/20">
            <PrettyObject data={sampleData} />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <div>
            <h4 className="text-sm font-medium mb-2">Simple String:</h4>
            <div className="border rounded-md p-3 bg-muted/20">
              <PrettyObject data="Hello, World!" />
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium mb-2">Empty Object:</h4>
            <div className="border rounded-md p-3 bg-muted/20">
              <PrettyObject data={{}} />
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium mb-2">URL:</h4>
            <div className="border rounded-md p-3 bg-muted/20">
              <PrettyObject data="https://example.com" />
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Beta Badge</h3>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span>New Feature</span>
            <BetaBadge />
          </div>
          <div className="flex items-center gap-2">
            <span>Custom Tooltip</span>
            <BetaBadge tooltipLabel="This feature is experimental and may change." />
          </div>
          <div className="flex items-center gap-2">
            <span>Custom Styling</span>
            <BetaBadge className="bg-purple-500 hover:bg-purple-500" />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Skeleton</h3>
        <div className="flex max-w-sm items-center gap-3 rounded-md border p-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </div>
    </div>
  )
}
