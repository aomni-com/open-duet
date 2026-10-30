'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'
import { MemoryRouter } from 'react-router'

import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import appEn from '../../messages/en/app.json'
import { mockFileStatApi, MockFileSystemProvider } from '../../spa/files/lib/mock-provider'
import type { FileStat, Result, VersionedFile } from '../../spa/files/lib/types'
import type { ProjectedMessage } from '../../spa/sessions/projection'
import { createSessionAuthorDirectory } from '../../spa/sessions/session-authors'
import { SessionFileViewerProvider } from '../../spa/sessions/session-file-viewer'
import { SessionTimeline } from '../../spa/sessions/session-message'

const CWD = 'projects/demo'

const LOCAL_MEDIA: Record<string, string> = {
  [`${CWD}/chart.png`]: '/playground/inline-media/cwd-chart.png',
  [`${CWD}/nested/chart.png`]: '/playground/inline-media/nested-chart.png',
  [`${CWD}/demo.webm`]: '/playground/inline-media/demo.webm',
  [`${CWD}/alternate.webm`]: '/playground/inline-media/alternate.webm',
  [`${CWD}/recap.wav`]: '/playground/inline-media/recap.wav',
  [`${CWD}/final%20plot.png`]: '/playground/inline-media/final%20plot.png',
}

function fixtureFileUrl(drivePath: string): string {
  return LOCAL_MEDIA[drivePath] ?? `/api/duet/ws/acme/files/${drivePath}`
}

const INLINE_MEDIA_AUTHORS = createSessionAuthorDirectory({
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

const SESSION_AGENT = {
  name: 'Research',
  avatarKey: 'research',
  workspaceSlug: 'acme',
}

export function SessionInlineMediaPlayground() {
  const [streamedTail, setStreamedTail] = useState('')
  const [videoSource, setVideoSource] = useState('demo.webm')
  const provider = useMemo(() => {
    const next = new InlineMediaPreviewProvider()
    next.seed([
      {
        path: `/${CWD}/model.weights`,
        data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      },
      {
        path: '/etc/hosts.txt',
        data: '127.0.0.1 localhost\n',
        contentType: 'text/plain',
      },
      /* The sent CSV's own bytes. An attachment card previews through the
         session file viewer, which reads this drive, so a file the message
         names but the drive lacks would draw as a bare chip. */
      {
        path: '/agents/research/uploads/research-data.csv',
        data: 'Channel,Owner,Status\nWeb,David,Ready\nMobile,Ada,Review\nEmail,Grace,Ready\n',
        contentType: 'text/csv',
      },
    ])
    return next
  }, [])
  const statApi = useMemo(() => mockFileStatApi(provider), [provider])

  const messages: ProjectedMessage[] = [
    {
      id: 'user-media',
      role: 'input',
      source: 'prompt',
      sender: { kind: 'user', userId: 'user_david' },
      text: 'I made this chart in the session folder.\n\n![User-authored cwd chart](chart.png)',
      images: [
        { storageId: 'cwd-chart', mimeType: 'image/png', bytes: 186_420 },
        { storageId: 'portrait', mimeType: 'image/png', bytes: 142_880 },
        { storageId: 'panorama', mimeType: 'image/png', bytes: 164_210 },
      ],
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
      createdAt: Date.UTC(2026, 6, 23, 9, 30),
    },
    {
      id: 'agent-media',
      role: 'agent',
      finalized: streamedTail !== '',
      parts: [
        {
          kind: 'text',
          id: 'agent-media-text',
          pending: streamedTail === '',
          text: `Here are the nested and remote views.

![Nested cwd chart](nested/chart.png)

![Remote route-fulfilled chart](https://media.example.test/remote.png)

The recording:

![Release walkthrough](${videoSource})

The audio recap:

![Audio recap](recap.wav)

[Release brief](release.pdf)

[Raw model artifact](model.weights)

[Outside-drive reference](/etc/hosts.txt)

[Open the Research agent](/w/acme/agents/research)

Encoded filename:

![Final plot with encoded space](final%20plot.png)${streamedTail}`,
        },
      ],
    },
  ]

  return (
    <MemoryRouter initialEntries={['/w/acme/sessions/inline-media']}>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <main className="min-h-screen bg-muted/20 px-3 py-8 text-foreground sm:px-8 sm:py-12">
          <div className="mx-auto w-full max-w-4xl space-y-5">
            <header className="flex flex-col gap-4 px-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
                  Session inline media
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                  Files stay grounded in the conversation
                </h1>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  Relative paths resolve from <code>{CWD}</code>; remote media stays explicit.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  onClick={() =>
                    setStreamedTail('\n\nStreaming tail appended without a new source.')
                  }
                >
                  Append streamed tail
                </button>
                <button
                  type="button"
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  onClick={() => setVideoSource('alternate.webm')}
                >
                  Change video source
                </button>
              </div>
            </header>

            <section className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
              <SessionFileViewerProvider workspaceSlug="acme" api={statApi} provider={provider}>
                <div role="log" aria-label="Inline media conversation">
                  <SessionTimeline
                    messages={messages}
                    duetName="Duet"
                    agent={SESSION_AGENT}
                    workspaceSlug="acme"
                    authors={INLINE_MEDIA_AUTHORS}
                    imageUrl={storageId => `/playground/inline-media/${storageId}.png`}
                    cwd={CWD}
                    fileUrl={fixtureFileUrl}
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

class InlineMediaPreviewProvider extends MockFileSystemProvider {
  override async stat(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<FileStat>> {
    if (!path.endsWith('/release.pdf')) return super.stat(path, options)
    return {
      success: true,
      data: {
        entry: {
          name: 'release.pdf',
          path: `/${CWD}/release.pdf`,
          size: 1_865,
          type: 'file',
          isDirectory: false,
        },
        etag: null,
      },
    }
  }

  override async readRange(
    path: string,
    range: { start: number; end: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    if (!path.endsWith('/release.pdf')) return super.readRange(path, range, options)
    try {
      const response = await fetch('/playground/session-files/release.pdf', {
        signal: options.signal,
      })
      if (!response.ok) throw new Error(`Fixture file returned ${response.status}`)
      const full = new Uint8Array(await response.arrayBuffer())
      return {
        success: true,
        data: {
          data: full.slice(range.start, range.end + 1),
          etag: null,
          contentType: 'application/pdf',
          size: full.byteLength,
        },
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  override downloadUrl(path: string, options: { version?: string | number } = {}): string {
    if (path.endsWith('/release.pdf')) return '/playground/session-files/release.pdf'
    return super.downloadUrl(path, options)
  }
}
