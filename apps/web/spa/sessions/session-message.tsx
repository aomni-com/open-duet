'use client'

import { AppWindowIcon, ChatCircleIcon, CircleNotch, UserIcon } from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from 'react-router'

import { AIMessage } from '@repo/ui/components/ai-elements'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar, type AgentAvatarProps } from '../agents/agent-avatar'
import { FileIconImage } from '../drive/drive-file-icon'
import { IdentityAvatarFrame, UserAvatar } from '../identity/identity-avatar'
import { messageStack, type MessageStackPosition } from './message-stack'
import { OrderedAgentParts } from './ordered-agent-parts'
import type { ProjectedMessage, ProjectedInputMessage } from './projection'
import { AttachmentCards } from './session-attachment-cards'
import {
  resolveSessionAuthor,
  useSessionAuthorCopy,
  type SessionAuthorDirectory,
  type SessionAuthorPortrait,
  type SessionAuthorPresentation,
} from './session-authors'
import { SessionMarkdown } from './session-markdown'
import { SessionTurnFooter } from './session-turn-usage'

type SessionMessageProps = {
  message: ProjectedMessage
  /** Where this row sits in its stack; a lone message is both ends of one. */
  stack?: MessageStackPosition
  duetName: string
  agent?: SessionAgentIdentity
  workspaceSlug?: string
  /** Whether the session's turn is running now — lets the open message count out loud. */
  running?: boolean
  /** Pinned clock for the counting line; absent means tick against the wall clock. */
  clockNow?: number
  /** current identity for every author in this transcript, resolved once */
  authors: SessionAuthorDirectory
  imageUrl: (storageId: string) => string
  cwd: string | undefined
  fileUrl: (drivePath: string) => string
}

export type SessionAgentIdentity = {
  name: string
  avatarKey: string
  profile?: AgentAvatarProps['profile']
  workspaceSlug?: string
}

export function SessionTimeline({
  messages,
  duetName,
  agent,
  workspaceSlug,
  running,
  clockNow,
  authors,
  imageUrl,
  cwd,
  fileUrl,
}: {
  messages: ProjectedMessage[]
  duetName: string
  agent?: SessionAgentIdentity
  workspaceSlug?: string
  running?: boolean
  clockNow?: number
  authors: SessionAuthorDirectory
  imageUrl: (storageId: string) => string
  cwd: string | undefined
  fileUrl: (drivePath: string) => string
}) {
  const stacks = messageStack(messages)
  return messages.map((message, index) => (
    <SessionMessage
      key={message.id}
      message={message}
      stack={stacks[index]}
      duetName={duetName}
      agent={agent}
      workspaceSlug={workspaceSlug}
      running={running}
      clockNow={clockNow}
      authors={authors}
      imageUrl={imageUrl}
      cwd={cwd}
      fileUrl={fileUrl}
    />
  ))
}

export function SessionMessage({
  message,
  stack = { leading: true, trailing: true },
  duetName,
  agent,
  workspaceSlug,
  running,
  clockNow,
  authors,
  imageUrl,
  cwd,
  fileUrl,
}: SessionMessageProps) {
  const t = useTranslations('duetApp.sessionProduct')
  const locale = useLocale()
  const copy = useSessionAuthorCopy()
  const isAgent = message.role === 'agent'
  const author =
    message.role === 'input' ? resolveSessionAuthor(message.sender, authors, copy) : undefined
  // Anything but a person typing here is input relayed into this conversation
  // from somewhere else, and the row says where it came from.
  const relayed = author !== undefined && author.category !== 'user'
  const agentName = agent?.name ?? duetName
  const authorName = author?.label ?? agentName

  /* Every row that has a start time shows it, the agent's included. Suppressing
     it on agent rows was a parity choice borrowed from another product; this one
     states as a contract that an assistant message says when it began — see
     `session-message.test.ts`. In a stack only the leading row prints it beside
     the name, and the rows under it carry theirs in the gutter. */
  const time =
    message.createdAt !== undefined
      ? { value: message.createdAt, label: formatMessageTime(message.createdAt, locale) }
      : undefined

  return (
    <AIMessage
      aria-label={t('messageFrom', { name: author?.accessibleLabel ?? agentName })}
      data-message-role={message.role}
      data-message-attribution={author?.category}
      data-message-stacked={stack.leading ? undefined : 'true'}
      className={cn(
        // Rhythm carries the grouping: a continuation sits close to what it
        // continues, and the stack itself gets the wider breath.
        'px-4 md:px-6',
        stack.leading ? 'pt-3' : 'pt-0.5',
        stack.trailing ? 'pb-3' : 'pb-0.5',
        // Relayed rows tint as one block, so the hairlines close the stack
        // rather than ruling between every message inside it.
        relayed && 'bg-muted/70 dark:bg-muted/30',
        relayed && stack.leading && 'border-t border-border/45',
        relayed && stack.trailing && 'border-b border-border/45',
      )}
    >
      <div className="@container/message relative flex min-w-0 items-start gap-3">
        <div className="relative flex w-7 shrink-0 justify-center @md/message:w-9">
          {stack.leading ? (
            // A relayed row wears its AUTHOR's own mark, never a human face and
            // never the Duet mascot: an app or another session under a person's
            // portrait is the attribution bug this row exists to prevent.
            <MessageAvatar
              portrait={author?.portrait}
              agentName={agentName}
              agent={isAgent ? agent : undefined}
            />
          ) : (
            <StackedTime time={time} />
          )}
        </div>
        <div className="w-0 min-w-0 flex-1">
          {stack.leading ? (
            <div className="flex min-w-0 items-center gap-2 pb-1">
              {author?.pending === true ? (
                /* The name is on its way, so the row holds its place with a
                   plain bar. Printed copy here — an ellipsis, or the generic
                   phrase a screen reader gets — reads as a name that failed to
                   render rather than as one still loading. */
                <span
                  data-message-author-placeholder
                  aria-hidden
                  className="h-3 w-28 shrink-0 rounded-full bg-muted"
                />
              ) : (
                <span
                  className={cn(
                    // Heavier than the body it heads: the author has to win the
                    // row against its own tinted category chip and the message
                    // under it, or the row stops answering "who wrote this".
                    'min-w-0 truncate text-sm font-semibold',
                    author?.unresolved === true
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-foreground',
                  )}
                >
                  {authorName}
                </span>
              )}
              {author?.categoryLabel === undefined ? null : (
                <AuthorCategory
                  category={author.category}
                  label={author.categoryLabel}
                  href={author.href}
                />
              )}
              {time ? (
                <time
                  dateTime={new Date(time.value).toISOString()}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {time.label}
                </time>
              ) : null}
              {!isAgent && message.source === 'note' ? (
                /* What kind of message this is, kept out of the identity
                   cluster and out of its pill grammar. Beside the category chip
                   it read as a second claim about the author; a bare label after
                   the clock cannot be mistaken for one. */
                <span className="shrink-0 text-[10px] font-semibold uppercase leading-4 tracking-wide text-foreground/60">
                  {t('note')}
                </span>
              ) : null}
            </div>
          ) : null}
          {message.role === 'input' ? (
            <InputMessageContent
              message={message}
              imageUrl={imageUrl}
              cwd={cwd}
              fileUrl={fileUrl}
              workspaceSlug={workspaceSlug}
            />
          ) : (
            <>
              <OrderedAgentParts
                parts={message.parts}
                cwd={cwd}
                workspaceSlug={workspaceSlug}
                fileUrl={fileUrl}
                agentName={authorName}
              />
              <SessionTurnFooter message={message} running={running} clockNow={clockNow} />
            </>
          )}
        </div>
      </div>
    </AIMessage>
  )
}

/**
 * Holds the avatar's footprint on a continuation row so the text column never
 * shifts, and offers the time to whoever hovers the row looking for it.
 */
function StackedTime({ time }: { time: { value: number; label: string } | undefined }) {
  if (!time) return null
  return (
    <time
      dateTime={new Date(time.value).toISOString()}
      // Taken out of flow on purpose: a clock reading is wider than the avatar
      // column it borrows, and it must not be able to set the row's height or
      // push the text column around.
      /* Shown outright where there is no pointer to hover with. On a touchscreen
         `group-hover` never fires, so this reading was not quiet — it did not
         exist, and a stacked message simply had no time on it. The reveal is the
         *pointer's* refinement, so it is the pointer that has to ask for it. */
      className="pointer-events-none absolute right-0 top-0 select-none whitespace-nowrap text-[11px] leading-6 text-muted-foreground opacity-60 transition-opacity md:opacity-0 md:group-hover:opacity-100"
    >
      {time.label}
    </time>
  )
}

function InputMessageContent({
  message,
  imageUrl,
  cwd,
  fileUrl,
  workspaceSlug,
}: {
  message: ProjectedInputMessage
  imageUrl: (storageId: string) => string
  cwd: string | undefined
  fileUrl: (drivePath: string) => string
  workspaceSlug: string | undefined
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const imageCount = message.images?.length ?? 0
  return (
    <>
      {/* A message can be files alone; it then opens on them, with no empty
          prose block or gap above. */}
      {message.text.trim().length > 0 ? (
        <SessionMarkdown
          text={message.text}
          cwd={cwd}
          workspaceSlug={workspaceSlug}
          fileUrl={fileUrl}
        />
      ) : null}
      {message.images?.length ? (
        <div
          className={cn(
            'mt-3 grid w-full min-w-0 gap-2 first:mt-0',
            imageCount === 1 ? 'max-w-lg grid-cols-1 justify-items-start' : 'max-w-xl grid-cols-2',
          )}
        >
          {message.images.map((image, index) => (
            <span
              key={'storageId' in image ? image.storageId : `optimistic:${index}`}
              data-message-inline-image
              className={cn(
                'grid overflow-hidden rounded-lg border border-border/70 bg-muted',
                imageCount === 1
                  ? 'w-fit max-w-full'
                  : 'relative aspect-square w-full place-items-center',
                imageCount === 3 && index === 0 && 'col-span-2 aspect-video',
              )}
            >
              {/* Session image URLs are authenticated/unoptimized and carry no dimensions.
                  A single image sizes from its decoded pixels; gallery canvases use contain
                  so every source stays complete inside a compact, predictable grid. */}
              {/* oxlint-disable-next-line next/no-img-element -- see rationale above */}
              <img
                loading="lazy"
                decoding="async"
                className={cn(
                  'block object-contain',
                  imageCount === 1
                    ? 'h-auto w-auto max-h-96 max-w-full'
                    : 'absolute inset-0 max-h-none max-w-none',
                )}
                style={imageCount === 1 ? undefined : { width: '100%', height: '100%' }}
                src={
                  'storageId' in image
                    ? imageUrl(image.storageId)
                    : `data:${image.mimeType};base64,${image.data}`
                }
                alt={t('attachment')}
              />
            </span>
          ))}
        </div>
      ) : null}
      {message.attachments?.length && workspaceSlug ? (
        <AttachmentCards attachments={message.attachments} workspaceSlug={workspaceSlug} />
      ) : null}
      {message.pending ? (
        <span
          role="status"
          className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
        >
          <CircleNotch className="size-3.5 animate-spin" aria-hidden />
          {t('sending')}
        </span>
      ) : null}
    </>
  )
}

/**
 * The word for what kind of author this is. It borrows the lineage chip's
 * geometry so a source reads as a source everywhere in the product, and takes a
 * different tint per class so a glance separates an app from a session.
 *
 * When the author is somewhere the reader can go — today only a session, which
 * lives on its own agent's surface — the chip is the way there. The name beside
 * it stays plain text on purpose: one target per row, and the chip is the part
 * that already says "this came from elsewhere".
 */
function AuthorCategory({
  category,
  label,
  href,
}: {
  category: SessionAuthorPresentation['category']
  label: string
  href: string | undefined
}) {
  const className = cn(
    'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-4',
    // Tinted at the same low weight as the lineage chip: enough to separate
    // the classes, never enough to outrank the name it belongs to.
    category === 'session'
      ? 'border-brand/20 bg-brand/[0.06] text-brand'
      : 'border-emerald-700/20 bg-emerald-600/[0.07] text-emerald-700 dark:text-emerald-300',
    /* A linked chip and a static one are the same object at rest, on purpose —
       the resting row belongs to the author's name, not to a call to action.
       Hover is where it has to declare itself, so it moves both the fill and
       the border rather than the fill alone, which at this tint is nearly
       invisible against the relayed row's own shading. */
    href !== undefined && 'hover:border-brand/40 hover:bg-brand/[0.14]',
  )
  // An unresolved or deleted author still wears the chip; it just isn't a link.
  return href === undefined ? (
    <span className={className}>{label}</span>
  ) : (
    <Link to={href} className={className}>
      {label}
    </Link>
  )
}

// Sized by the thread's own width, not the viewport's: the same timeline runs
// full-bleed on the sessions route and inside the map's narrow column.
const PORTRAIT_SIZE = 'size-7 @md/message:size-9'
const PORTRAIT_GLYPH = 'size-4 @md/message:size-5'

function MessageAvatar({
  portrait,
  agentName,
  agent,
}: {
  /** absent on an agent row, which is identified by the agent, not by a sender */
  portrait: SessionAuthorPortrait | undefined
  agentName: string
  agent: SessionAgentIdentity | undefined
}) {
  if (portrait === undefined || portrait.kind === 'duet')
    return (
      <AgentAvatar
        data-message-avatar
        avatarKey={agent?.avatarKey ?? agentName}
        duet={agent === undefined}
        profile={agent?.profile}
        workspaceSlug={agent?.workspaceSlug}
        className={cn(PORTRAIT_SIZE, 'ring-1 ring-border/70')}
      />
    )

  switch (portrait.kind) {
    case 'person':
      return <UserAvatar data-message-avatar name={portrait.name} className={PORTRAIT_SIZE} />
    case 'person-unknown':
      return (
        <IdentityAvatarFrame
          data-message-avatar
          kind="user"
          aria-hidden
          className={cn(
            PORTRAIT_SIZE,
            'grid place-items-center bg-amber-500/10 text-amber-700 ring-1 ring-amber-600/25 dark:text-amber-400',
          )}
        >
          {/* Still a person's silhouette: what is broken is that we cannot name
              them, not what kind of author they are. The tint carries the
              alarm; a bare warning glyph would lose the category. */}
          <UserIcon weight="duotone" className={PORTRAIT_GLYPH} />
        </IdentityAvatarFrame>
      )
    case 'person-pending':
      return (
        <IdentityAvatarFrame
          data-message-avatar
          kind="user"
          aria-hidden
          className={cn(
            PORTRAIT_SIZE,
            'grid place-items-center bg-muted text-muted-foreground ring-1 ring-border/70',
          )}
        >
          <UserIcon weight="duotone" className={PORTRAIT_GLYPH} />
        </IdentityAvatarFrame>
      )
    // An app and a session are not people, so they do not wear a person's
    // portrait geometry: each keeps its own mark's shape and tint.
    case 'app-icon':
      return (
        // An app's own icon is how its users already recognize it, framed the
        // way `AppIcon` frames it everywhere else and with no ring outside the
        // box: an icon and the mark that stands in when it cannot be drawn have
        // to occupy the very same square, or a missing file moves the row.
        <FileIconImage
          data-message-avatar
          src={portrait.src}
          className={cn(PORTRAIT_SIZE, 'shrink-0 rounded-md object-cover')}
          fallback={<GenericAppMark />}
        />
      )
    case 'app':
      return <GenericAppMark />
    case 'session':
      return (
        <span
          data-message-avatar
          aria-hidden
          className={cn(
            PORTRAIT_SIZE,
            'grid shrink-0 place-items-center rounded-full border border-brand/25 bg-brand/[0.08] text-brand',
          )}
        >
          <ChatCircleIcon weight="duotone" className={PORTRAIT_GLYPH} />
        </span>
      )
  }
}

/** What an app wears when it has no icon of its own, or its icon cannot load. */
function GenericAppMark() {
  return (
    <span
      data-message-avatar
      aria-hidden
      className={cn(
        PORTRAIT_SIZE,
        'grid shrink-0 place-items-center rounded-md border border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      <AppWindowIcon weight="duotone" className={PORTRAIT_GLYPH} />
    </span>
  )
}

function formatMessageTime(value: number, locale: string) {
  const date = new Date(value)
  const today = new Date()
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  return new Intl.DateTimeFormat(
    locale,
    isToday
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  ).format(date)
}
