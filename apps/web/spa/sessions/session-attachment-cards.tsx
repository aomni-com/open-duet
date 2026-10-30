'use client'

import Image from 'next/image'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import {
  AGENT_INPUT_IMAGE_MAX_BYTES,
  AGENT_INPUT_IMAGE_MIME_TYPES,
  isTextLikeDriveFile,
  type AgentEventAttachment,
} from '@repo/contract'
import { AttachmentCard, attachmentPreview } from '@repo/ui/components/compose-bar'

import { duetApi } from '../api/client'
import { loadFileTextPreview } from '../api/file-previews'
import { driveDestination } from '../drive/drive-routes'
import { FileGlyph } from '../files/file-glyph'
import { formatBytes } from '../format'
import { useSessionFileViewer } from './session-file-viewer'

export function AttachmentCards({
  attachments,
  workspaceSlug,
}: {
  attachments: readonly AgentEventAttachment[]
  workspaceSlug: string
}) {
  const viewer = useSessionFileViewer()
  return (
    <div className="mt-3 flex max-w-3xl flex-wrap gap-2 first:mt-0">
      {attachments.map(attachment => {
        const kind = previewKind(attachment)
        return (
          <AttachmentOpener
            key={attachment.path}
            attachment={attachment}
            workspaceSlug={workspaceSlug}
            onOpen={
              viewer === null
                ? undefined
                : trigger =>
                    viewer.openFile(
                      {
                        path: attachment.path,
                        size: attachment.bytes,
                      },
                      trigger,
                    )
            }
          >
            <AttachmentCard
              name={attachment.name}
              meta={formatBytes(attachment.bytes, 1000)}
              className="w-full"
              preview={
                kind === 'default' ? undefined : (
                  <AttachmentPreview
                    attachment={attachment}
                    url={
                      viewer?.fileUrl(attachment.path) ??
                      duetApi.workspaceFileDownloadUrl(workspaceSlug, attachment.path)
                    }
                  />
                )
              }
            />
          </AttachmentOpener>
        )
      })}
    </div>
  )
}

function AttachmentOpener({
  attachment,
  workspaceSlug,
  onOpen,
  children,
}: {
  attachment: AgentEventAttachment
  workspaceSlug: string
  onOpen?(trigger: HTMLButtonElement): void
  children: ReactNode
}) {
  const className =
    'group w-[calc(50%-0.25rem)] rounded-xl text-left outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-44'
  return onOpen ? (
    <button
      type="button"
      data-message-attachment-card
      aria-label={attachment.name}
      className={className}
      onClick={event => onOpen(event.currentTarget)}
    >
      {children}
    </button>
  ) : (
    <Link
      data-message-attachment-card
      to={driveDestination(workspaceSlug, attachment.path, 'file')}
      aria-label={attachment.name}
      className={className}
    >
      {children}
    </Link>
  )
}

function AttachmentPreview({ attachment, url }: { attachment: AgentEventAttachment; url: string }) {
  const kind = previewKind(attachment)
  const snippet = useTextSnippet(kind === 'text' || kind === 'table' ? url : undefined)

  if (kind === 'image')
    return (
      <Image
        unoptimized
        fill
        sizes="176px"
        src={url}
        alt=""
        loading="lazy"
        className="size-full object-contain p-1"
      />
    )

  if (kind === 'table' && snippet !== undefined) {
    const rows = snippet
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 4)
      .map(row => row.split(/[,\t]/).slice(0, 3))
    return attachmentPreview({
      id: attachment.path,
      name: attachment.name,
      preview: { kind: 'table', rows },
    })
  }

  if (kind === 'text' && snippet !== undefined)
    return attachmentPreview({
      id: attachment.path,
      name: attachment.name,
      preview: { kind: 'text', text: snippet },
    })

  return <FileGlyph entry={{ name: attachment.name, isDirectory: false }} className="size-8" />
}

function previewKind(
  attachment: AgentEventAttachment,
): 'image' | 'table' | 'text' | 'default' | 'glyph' {
  const extension = attachment.name.split('.').at(-1)?.toLowerCase()
  if (
    attachment.bytes <= AGENT_INPUT_IMAGE_MAX_BYTES &&
    AGENT_INPUT_IMAGE_MIME_TYPES.some(mimeType => mimeType === attachment.mimeType)
  )
    return 'image'
  if (extension === 'csv' || extension === 'tsv') return 'table'
  if (attachment.mimeType?.startsWith('text/') || isTextLikeDriveFile(attachment.name))
    return 'text'
  if (extension === 'pdf') return 'default'
  return 'glyph'
}

function useTextSnippet(url: string | undefined): string | undefined {
  const [snippet, setSnippet] = useState<string>()

  useEffect(() => {
    if (url === undefined) {
      setSnippet(undefined)
      return
    }
    const controller = new AbortController()
    void loadFileTextPreview(url, controller.signal)
      .then(value => setSnippet(value))
      .catch(() => undefined)
    return () => controller.abort()
  }, [url])

  return snippet
}
