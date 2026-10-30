'use client'

import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react'

import { Markdown } from '@repo/ui/components/common/markdown'
import { cn } from '@repo/ui/lib/utils'

import { agentsMapUrl } from '../drive/agents-map-url'
import { FileGlyph, fileKind } from '../files/file-glyph'
import { fileName as logicalFileName, isBrowserFilePath } from '../files/lib/paths'
import { finalPathSegment, mediaKind } from './media-kind'
import { resolveMediaSrc } from './media-src'
import { useSessionFileViewer } from './session-file-viewer'
import { useSessionLinkClick } from './session-link'
import { agentChipSlug, skillChipName, withMentionChips } from './session-mention-chips'

type SessionMarkdownProps = {
  text: string
  cwd: string | undefined
  /**
   * Needed to build an agent chip's destination; `agentsMapUrl` is its only
   * builder. Absent outside a workspace route, where the chip still renders —
   * it just has nowhere to go.
   */
  workspaceSlug: string | undefined
  fileUrl(drivePath: string): string
  className?: string
}

const messageMarkdownClassName =
  'text-sm leading-6 text-foreground [&_li]:!text-sm [&_ol]:my-2 [&_p]:!my-0 [&_p]:leading-6 [&_ul]:my-2'

type SessionMarkdownContextValue = {
  cwd: string | undefined
  workspaceSlug: string | undefined
  fileUrl(drivePath: string): string
  onLinkClicked(href: string): void
}

const SessionMarkdownContext = createContext<SessionMarkdownContextValue | null>(null)

export function SessionMarkdown({
  text,
  cwd,
  workspaceSlug,
  fileUrl,
  className,
}: SessionMarkdownProps) {
  const onLinkClicked = useSessionLinkClick()

  return (
    <SessionMarkdownContext.Provider value={{ cwd, workspaceSlug, fileUrl, onLinkClicked }}>
      <Markdown
        onLinkClicked={onLinkClicked}
        className={cn(messageMarkdownClassName, className)}
        components={SESSION_MARKDOWN_COMPONENTS}
      >
        {withMentionChips(text)}
      </Markdown>
    </SessionMarkdownContext.Provider>
  )
}

function SessionMedia({
  node: _,
  src = '',
  alt = '',
  title,
  ...props
}: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const context = useSessionMarkdownContext()
  const markdownSrc = typeof src === 'string' ? src : ''
  const resolved = resolveSessionSrc(context, markdownSrc)
  const kind = mediaKind(markdownSrc)

  if (kind === 'image')
    return (
      <img
        key={resolved.src}
        {...props}
        src={resolved.src}
        alt={alt}
        title={title}
        className="my-3 h-auto max-h-[32rem] max-w-full rounded-lg border border-border/70 bg-muted object-contain"
      />
    )

  if (kind === 'video')
    return (
      <video
        key={resolved.src}
        src={resolved.src}
        title={title ?? alt}
        controls
        playsInline
        preload="metadata"
        className="my-3 aspect-video w-full max-w-xl rounded-lg border border-border/70 bg-muted object-contain"
      >
        {alt}
      </video>
    )

  if (kind === 'audio')
    return (
      <audio
        key={resolved.src}
        src={resolved.src}
        title={title ?? alt}
        controls
        preload="metadata"
        className="my-3 w-full max-w-xl"
      >
        {alt}
      </audio>
    )

  return (
    <FileCard
      key={resolved.src}
      href={resolved.src}
      name={alt || fileName(markdownSrc)}
      path={resolved.mode === 'drive' ? resolved.drivePath : resolved.href}
      previewPath={
        resolved.mode === 'drive' && isBrowserFilePath(resolved.drivePath)
          ? resolved.drivePath
          : undefined
      }
    />
  )
}

function SessionAnchor({
  node: _,
  href = '',
  children,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const context = useSessionMarkdownContext()
  // A skill the sender invoked, drawn as the chip they saw in the composer —
  // and inert, because it names a capability rather than a destination.
  const skill = skillChipName(href)
  if (skill !== null) {
    return (
      <span
        data-session-skill={skill}
        className="rounded bg-brand/[0.12] px-1 font-medium text-brand"
      >
        /{skill}
      </span>
    )
  }

  // An agent someone named. Unlike a skill this *is* a destination, so it stays
  // a real link — the agent has a page, and the chip is the shortest way there.
  const agentSlug = agentChipSlug(href)
  if (agentSlug !== null) {
    // Outside a workspace route there is no page to send anyone to, so the chip
    // reads the same but stays put rather than linking somewhere wrong.
    if (context.workspaceSlug === undefined) {
      return (
        <span
          data-session-agent={agentSlug}
          className="rounded bg-brand/[0.12] px-1 font-medium text-brand"
        >
          {children}
        </span>
      )
    }
    const destination = agentsMapUrl(context.workspaceSlug, {
      kind: 'agent',
      agentSlug,
      card: { kind: 'default' },
    })
    return (
      <a
        data-session-agent={agentSlug}
        href={destination}
        className="rounded bg-brand/[0.12] px-1 font-medium text-brand transition-colors hover:bg-brand/20"
        onClick={event => {
          event.preventDefault()
          context.onLinkClicked(destination)
        }}
      >
        {children}
      </a>
    )
  }

  const resolved = resolveSessionSrc(context, href)
  if (
    resolved.mode === 'drive' &&
    isBrowserFilePath(resolved.drivePath) &&
    hasFileLikeFinalSegment(href)
  ) {
    return (
      <FileCard
        href={resolved.src}
        name={plainText(children) || fileName(href)}
        path={resolved.drivePath}
        previewPath={resolved.drivePath}
      />
    )
  }

  return (
    <a
      target="_blank"
      {...props}
      href={href}
      // Weight alone did not separate a link from emphasis, and the brand blue
      // belongs to what is live. An underline says "this goes somewhere"
      // without spending the accent.
      className="!underline decoration-border decoration-[1.25px] underline-offset-[3px] transition-colors hover:decoration-foreground/70"
      onClick={event => {
        event.preventDefault()
        context.onLinkClicked(href)
      }}
    >
      {children}
    </a>
  )
}

function useSessionMarkdownContext(): SessionMarkdownContextValue {
  const context = useContext(SessionMarkdownContext)
  if (context === null) throw new Error('Session Markdown component rendered without its owner')
  return context
}

function resolveSessionSrc(context: SessionMarkdownContextValue, src: string) {
  const resolved = resolveMediaSrc({ src, cwd: context.cwd })
  return resolved.mode === 'remote'
    ? { ...resolved, src: resolved.href }
    : { ...resolved, src: context.fileUrl(resolved.drivePath) }
}

// The shared Markdown component keeps its own `p` default; only the media
// overrides live here.
const SESSION_MARKDOWN_COMPONENTS = {
  img: SessionMedia,
  a: SessionAnchor,
}

function FileCard({
  href,
  name,
  path,
  previewPath,
}: {
  href: string
  name: string
  path: string
  previewPath?: string
}) {
  const viewer = useSessionFileViewer()
  const sourceName = previewPath === undefined ? fileName(path) : logicalFileName(previewPath)
  const kind = fileKind(sourceName)
  const className =
    'my-2 flex w-full max-w-xl items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left text-foreground shadow-xs transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const content = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/60">
        <FileGlyph entry={{ name: sourceName, isDirectory: false }} className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {kind.key.toUpperCase()} · {path}
        </span>
      </span>
    </>
  )
  return viewer && previewPath ? (
    <button
      type="button"
      data-session-file-card
      className={className}
      onClick={event => viewer.openFile({ path: previewPath }, event.currentTarget)}
    >
      {content}
    </button>
  ) : (
    <a data-session-file-card href={href} target="_blank" rel="noreferrer" className={className}>
      {content}
    </a>
  )
}

function hasFileLikeFinalSegment(href: string): boolean {
  const finalSegment = finalPathSegment(href)
  const dot = finalSegment.lastIndexOf('.')
  return dot > 0 && dot < finalSegment.length - 1
}

function fileName(href: string): string {
  const encoded = finalPathSegment(href)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return ''
  return children.map(plainText).join('')
}
