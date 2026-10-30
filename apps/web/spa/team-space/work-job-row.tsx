import type { SessionListItem } from '@repo/contract'

import { ChatMarks, chatMarkState } from '../routes/agents-map/chat-marks'

/**
 * One job in the Recent jobs panel: its title, the agent it belongs to, and
 * what it is doing.
 *
 * These are the same conversations Work's sidebar lists, so the state rides the
 * trailing edge in `ChatMarks`, exactly as it does there. The panel already
 * groups rows under their state's name, and the mark agrees with the heading
 * rather than inventing a colour for it: a done job wears nothing, the way a
 * resting chat does everywhere else.
 */
export function WorkJobRow({
  job,
  ownerName,
  unreadLabel,
  onOpen,
}: {
  job: SessionListItem
  ownerName: string
  unreadLabel: string
  /** absent when the job's owner cannot be resolved, which disables the row */
  onOpen: (() => void) | undefined
}) {
  const { state, tone } = chatMarkState(job.bucket)
  return (
    <button
      type="button"
      disabled={onOpen === undefined}
      onClick={onOpen}
      className="flex w-full items-center rounded-lg px-2 py-2 text-left outline-none transition-[background-color,transform] hover:bg-sidebar-accent active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transform-none"
    >
      <span className="min-w-0 flex-1">
        {/* The marks sit on the title's line, at its end, as they do on a
            sidebar row: they are about this job, and the owner's name under it
            is a caption, not a second thing for them to straddle. */}
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{job.title}</span>
          <ChatMarks unread={job.unread} state={state} tone={tone} label={unreadLabel} />
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{ownerName}</span>
      </span>
    </button>
  )
}
