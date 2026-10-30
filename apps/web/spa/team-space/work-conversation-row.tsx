import type { SessionListItem } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { ChatMarks, chatMarkState } from '../routes/agents-map/chat-marks'

/**
 * One chat in Work's sidebar: the title, and what the chat is doing.
 *
 * The leading slot is empty on purpose. It keeps every title on the column the
 * sidebar's other labels start on, so a chat lines up with Home and a nested
 * chat with its agent's name, without drawing a bullet that says nothing. What
 * the chat is doing rides the trailing edge in `ChatMarks`, the marks Build's
 * roster draws for an agent's own chat, so "running", "asking" and "unread"
 * read the same in both sidebars, and a resting chat wears nothing.
 */
export function WorkConversationRow({
  chat,
  active,
  unreadLabel,
  onOpen,
}: {
  chat: SessionListItem
  active: boolean
  unreadLabel: string
  onOpen: () => void
}) {
  const { state, tone } = chatMarkState(chat.bucket)
  return (
    <button
      type="button"
      data-work-conversation={chat.id}
      title={chat.title}
      onClick={onOpen}
      className={cn(
        'group flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-[background-color,color,transform] duration-150 hover:bg-sidebar-accent/70 hover:text-foreground active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transform-none lg:min-h-0',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground',
        /* Weight, and full ink only off the active row: the active row paints
           its own foreground against the accent wash, and "you are reading
           this" and "this is unread" should not fight over one colour. */
        chat.unread && 'font-semibold',
        chat.unread && !active && 'text-foreground',
      )}
    >
      {/* The width of Home's icon, so this title starts exactly where Home's
          label does. */}
      <span aria-hidden className="w-[17px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      <ChatMarks unread={chat.unread} state={state} tone={tone} label={unreadLabel} />
    </button>
  )
}
