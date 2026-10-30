'use client'

import { MemoryRouter } from 'react-router'

import { Markdown } from '@repo/ui/components/common/markdown'

import { SessionMarkdown } from '../../spa/sessions/session-markdown'

const MARKDOWN_KITCHEN_SINK = `# Markdown field guide

This production renderer should feel composed through long operational reading. A soft-wrapped
source line stays in the same paragraph, while a hard break\u0020\u0020
starts a deliberate new line.

## Inline language

Plain text can be **strong**, *emphasized*, ***both***, ~~struck through~~, or contain \`inline code\`. Links may be [authored paths](/w/acme/agents/root) or bare GFM autolinks like <https://duet.so>. Escaped punctuation stays literal: \\*not emphasis\\*.

---

## Lists

### Tight unordered list

- Each item stays compact.
- Markers align with wrapped lines that continue long enough to demonstrate the hanging indent.
- A final item contains **emphasis** and \`code\`.

### Loose ordered list

1. **Its last real activity was at 05:57:28 UTC.**

   The final recorded action created the Chief of Staff icon. After that, there were no new events for more than 10 hours.

2. **The icon task had already finished.**

   It produced a valid 1024×1024 image. The file was above the upload limit, but the generation task itself had settled.

3. **A new message could be submitted but was never processed.**

   The message appeared in session history, but the runner produced no subsequent action.

### Nested and task lists

- Prepare the release
  1. Review the migration
  2. Confirm the rollback path
- Notify the team
  - [x] Draft the update
  - [ ] Send after deployment

## Quotation

> Durable work should remain legible when it becomes detailed.
>
> A second paragraph should belong to the quotation without opening an accidental canyon.

## Code

\`\`\`ts
type SessionState = 'running' | 'waiting' | 'complete'

const canResume = (state: SessionState) => state !== 'running'
\`\`\`

## Table

| Surface | Owner | State |
| :-- | :-- | --: |
| Session | Maya | 12 |
| Files | Duet | 8 |

## Media and math

![A warm desk used for the deterministic Markdown fixture](/playground/session-image.jpg)

Inline math keeps its source semantics: $E = mc^2$.

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

### Heading level three

#### Heading level four

##### Heading level five

###### Heading level six

Raw HTML is inert but its words remain readable: <mark>never live markup</mark>.
`

const SESSION_LIST = `The evidence points to one stalled runner rather than a failed task.

1. **Its last real activity was at 05:57:28 UTC.**

   The final recorded action created the Chief of Staff icon. After that, there were no new events for more than 10 hours.

2. **The icon task had already finished.**

   It produced a valid 1024×1024 image. The file was 2.06 MB, above the 1 MB limit, but the image-generation task itself had settled. The session should have compressed it and continued.

3. **A new message could be submitted but was never processed.**

   I sent instructions to resume. The message appeared in session history, but the runner produced no response or subsequent action.

4. **The interrupt returned \`interrupt_undeliverable\`.**

   That is the strongest evidence. Duet tried to deliver an interrupt to a process that was no longer available.`

export function MarkdownPlayground() {
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8 sm:py-12">
      <article className="mx-auto max-w-3xl" data-markdown-document>
        <Markdown>{MARKDOWN_KITCHEN_SINK}</Markdown>
      </article>
    </main>
  )
}

export function SessionMarkdownPlayground() {
  return (
    <MemoryRouter>
      <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8 sm:py-12">
        <article
          className="mx-auto max-w-3xl rounded-xl border border-border/70 bg-card p-4 sm:p-6"
          data-markdown-session
        >
          <SessionMarkdown
            text={SESSION_LIST}
            cwd="/agents/chief-of-staff"
            workspaceSlug="acme"
            fileUrl={path => `/files${path}`}
          />
        </article>
      </main>
    </MemoryRouter>
  )
}
