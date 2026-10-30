import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

type WorkSessionHeadingProps = {
  title: string
  source?: string
  className?: string
  /**
   * The title as a control, when this reader can rename the conversation.
   *
   * A node rather than a flag, because renaming is a mutation with a toast and
   * a cache behind it and this file is a heading. Absent — a conversation still
   * opening, or one reached as somebody else's child — draws the plain heading,
   * which is the same words either way.
   */
  titleControl?: ReactNode
}

export function WorkSessionHeading({
  title,
  source,
  className,
  titleControl,
}: WorkSessionHeadingProps) {
  return (
    <div className={cn('min-w-0', className)}>
      {/* One name, and it is this surface's heading either way. The control is
          wrapped rather than replacing the heading: a reader moving by headings
          lands on the conversation's name whether or not they may rename it, and
          the wrapper carries the role because the control opens a `<form>` while
          editing — flow content an `<h1>` may not hold. */}
      {titleControl === undefined ? (
        <h1 className="truncate text-sm font-semibold">{title}</h1>
      ) : (
        <div role="heading" aria-level={1} className="min-w-0">
          {titleControl}
        </div>
      )}
      {source === undefined ? null : (
        <p className="truncate text-[11px] text-muted-foreground">{source}</p>
      )}
    </div>
  )
}
