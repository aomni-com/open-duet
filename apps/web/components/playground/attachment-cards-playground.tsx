'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useMemo } from 'react'
import { MemoryRouter } from 'react-router'
import * as XLSX from 'xlsx'

import appEn from '../../messages/en/app.json'
import { mockFileStatApi, MockFileSystemProvider } from '../../spa/files/lib/mock-provider'
import type { Result, VersionedFile } from '../../spa/files/lib/types'
import type { ProjectedMessage } from '../../spa/sessions/projection'
import { createSessionAuthorDirectory } from '../../spa/sessions/session-authors'
import { SessionFileViewerProvider } from '../../spa/sessions/session-file-viewer'
import { SessionTimeline } from '../../spa/sessions/session-message'

const AUTHORS = createSessionAuthorDirectory({
  members: [
    {
      id: 'user_david',
      email: 'david@example.com',
      name: 'David Zhang',
      role: 'owner',
      isBillingUser: true,
    },
  ],
})

const AGENT = { name: 'Research', avatarKey: 'research', workspaceSlug: 'acme' }

const messages: ProjectedMessage[] = [
  {
    id: 'mixed-attachments',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'user', userId: 'user_david' },
    text: 'Use this image with the brief and research table.',
    images: [{ storageId: 'portrait', mimeType: 'image/png', bytes: 186_420 }],
    attachments: [
      {
        path: 'agents/research/uploads/release-brief.pdf',
        name: 'release-brief.pdf',
        bytes: 84_203,
        mimeType: 'application/pdf',
      },
      {
        path: 'agents/research/uploads/research-data.csv',
        name: 'research-data.csv',
        bytes: 12_480,
        mimeType: 'text/csv',
      },
    ],
    createdAt: Date.UTC(2026, 7, 12, 15, 20),
  },
  {
    id: 'ten-attachments',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'user', userId: 'user_david' },
    text: 'These are the ten launch files for the final handoff.',
    attachments: [
      ['launch-plan.md', 18_420, 'text/markdown'],
      ['metrics.csv', 42_110, 'text/csv'],
      ['brand-guide.pdf', 2_840_300, 'application/pdf'],
      ['panorama.png', 386_200, 'image/png'],
      ['logo.svg', 24_880, 'image/svg+xml'],
      ['demo.webm', 8_420_000, 'video/webm'],
      ['launch-theme.mp3', 1_920_000, 'audio/mpeg'],
      [
        'launch-plan.xlsx',
        42_210,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      [
        'launch-brief.docx',
        36_224,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      [
        'launch-deck.pptx',
        29_668,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ],
    ].map(([name, bytes, mimeType]) => ({
      path: `agents/research/uploads/${name}`,
      name: String(name),
      bytes: Number(bytes),
      mimeType: String(mimeType),
    })),
    createdAt: Date.UTC(2026, 7, 12, 15, 24),
  },
]

export function AttachmentCardsPlayground() {
  const provider = useMemo(() => {
    const next = new AttachmentPreviewProvider()
    next.seed([
      {
        path: '/agents/research/uploads/research-data.csv',
        data: 'Channel,Owner,Status\nWeb,David,Ready\nMobile,Ada,Review\nEmail,Grace,Ready',
        contentType: 'text/csv',
      },
      ...messages
        .flatMap(message => ('attachments' in message ? (message.attachments ?? []) : []))
        .filter(
          attachment =>
            attachment.name !== 'release-brief.pdf' && attachment.name !== 'research-data.csv',
        )
        .map(attachment =>
          attachment.name === 'launch-plan.xlsx'
            ? {
                path: `/${attachment.path}`,
                data: launchWorkbook(),
                contentType: attachment.mimeType,
              }
            : {
                path: `/${attachment.path}`,
                data: `Preview fixture for ${attachment.name}`,
                contentType: attachment.mimeType,
              },
        ),
    ])
    return next
  }, [])
  const statApi = useMemo(() => mockFileStatApi(provider), [provider])

  return (
    <MemoryRouter initialEntries={['/w/acme/agents/research/session/demo']}>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <main className="min-h-screen bg-muted/20 px-3 py-8 text-foreground sm:px-8 sm:py-12">
          <div className="mx-auto w-full max-w-4xl space-y-5">
            <header className="px-1">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
                Sent attachments
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                Files remain part of the message
              </h1>
            </header>
            <section className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
              <SessionFileViewerProvider workspaceSlug="acme" api={statApi} provider={provider}>
                <div role="log" aria-label="Attachment card conversation">
                  <SessionTimeline
                    messages={messages}
                    duetName="Duet"
                    agent={AGENT}
                    workspaceSlug="acme"
                    authors={AUTHORS}
                    imageUrl={storageId => `/playground/inline-media/${storageId}.png`}
                    cwd="agents/research"
                    fileUrl={path => provider.downloadUrl(path)}
                  />
                </div>
              </SessionFileViewerProvider>
            </section>
          </div>
        </main>
      </NextIntlClientProvider>
    </MemoryRouter>
  )
}

function launchWorkbook(): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Plan', 'Owner', 'Status'],
      ['API docs', 'Maya', 'Ready'],
      [
        'Launch QA',
        'David',
        'A deliberately long handoff note that remains readable instead of disappearing into an ellipsis.',
      ],
    ]),
    'Launch plan',
  )
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Channel', 'Owner', 'Status', 'Window', 'Region', 'Notes'],
      ['Web', 'Maya', 'Ready', 'Tuesday', 'Global', 'Primary launch surface'],
      ['Mobile', 'David', 'Review', 'Wednesday', 'Americas', 'Store review pending'],
    ]),
    'Channels',
  )
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
}

class AttachmentPreviewProvider extends MockFileSystemProvider {
  override async readVersioned(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    const asset = sessionFileAsset(path)
    return asset === undefined
      ? super.readVersioned(path, options)
      : readFixtureAsset(asset, options)
  }

  override async readRange(
    path: string,
    range: { start: number; end: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    const asset = sessionFileAsset(path)
    if (asset === undefined) return super.readRange(path, range, options)
    const result = await readFixtureAsset(asset, options)
    if (!result.success) return result
    return {
      success: true,
      data: { ...result.data, data: result.data.data.slice(range.start, range.end + 1) },
    }
  }

  override downloadUrl(path: string, options: { version?: string | number } = {}): string {
    if (path.endsWith('/launch-theme.mp3')) return '/playground/inline-media/recap.wav'
    if (path.endsWith('/panorama.png')) return '/playground/inline-media/panorama.png'
    if (path.endsWith('/logo.svg')) return '/playground/inline-media/logo.svg'
    if (path.endsWith('/demo.webm')) return '/playground/inline-media/demo.webm'
    const asset = sessionFileAsset(path)
    if (asset !== undefined) return asset.url
    return super.downloadUrl(path, options)
  }
}

function sessionFileAsset(path: string): { url: string; contentType: string } | undefined {
  const name = path.split('/').at(-1)
  if (name === 'release-brief.pdf')
    return { url: '/playground/session-files/release-brief.pdf', contentType: 'application/pdf' }
  if (name === 'launch-brief.docx')
    return {
      url: '/playground/session-files/launch-brief.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
  if (name === 'launch-deck.pptx')
    return {
      url: '/playground/session-files/launch-deck.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }
  return undefined
}

async function readFixtureAsset(
  asset: { url: string; contentType: string },
  options: { signal?: AbortSignal },
): Promise<Result<VersionedFile>> {
  try {
    const response = await fetch(asset.url, { signal: options.signal })
    if (!response.ok) throw new Error(`Fixture file returned ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    return {
      success: true,
      data: { data, etag: null, contentType: asset.contentType, size: data.byteLength },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
