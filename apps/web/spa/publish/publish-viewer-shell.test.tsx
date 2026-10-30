import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ViewerDescriptor } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import type { DirectoryEntry } from '../files/lib/types'
import type { PublishViewerState } from './publish-viewer-controller'
import { PublishViewerShell } from './publish-viewer-shell'

const descriptor: ViewerDescriptor = {
  workspaceName: 'Acme Drive',
  ownerName: 'Ada Lovelace',
  rootName: 'guides',
  kind: 'folder',
}

const entries: DirectoryEntry[] = [
  { name: 'intro.md', path: '/intro.md', type: 'file', isDirectory: false, size: 12 },
  { name: 'chapters', path: '/chapters', type: 'directory', isDirectory: true },
  { name: '.agents', path: '/.agents', type: 'directory', isDirectory: true },
  { name: '.notes', path: '/.notes', type: 'file', isDirectory: false, size: 6 },
]

function renderShell(state: PublishViewerState, archiveUrl?: (path: string) => string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <PublishViewerShell
        descriptor={descriptor}
        state={state}
        query=""
        onQueryChange={() => {}}
        onNavigate={() => {}}
        onRetry={() => {}}
        provider={null}
        workspaceSlug="acme-drive"
        archiveUrl={archiveUrl}
      />
    </NextIntlClientProvider>,
  )
}

const archive = (path: string) => `https://edge.example/acme-drive/q2${path}?zip`

test('a nested folder view offers a quiet download-as-zip link in the banner', () => {
  const html = renderShell({ status: 'folder', path: '/chapters', entries }, archive)
  expect(html).toContain('https://edge.example/acme-drive/q2/chapters?zip')
  expect(html).toContain('Download as ZIP')
})

test('the publish root folder shows no download affordance', () => {
  const html = renderShell({ status: 'folder', path: '/', entries }, archive)
  expect(html).not.toContain('?zip')
  expect(html).not.toContain('Download as ZIP')
})

test('no archive link renders when the surface supplies no archive URL', () => {
  const html = renderShell({ status: 'folder', path: '/chapters', entries }, undefined)
  expect(html).not.toContain('?zip')
  expect(html).not.toContain('Download as ZIP')
})

test('dotfile entries are hidden by default, with a show-hidden toggle offered', () => {
  const html = renderShell({ status: 'folder', path: '/', entries })
  expect(html).toContain('intro.md')
  expect(html).toContain('chapters')
  expect(html).not.toContain('.notes')
  expect(html).not.toContain('.agents')
  expect(html).toContain('Show hidden files')
})

test('a paged public folder offers an explicit continuation control', () => {
  const html = renderShell({
    status: 'folder',
    path: '/',
    entries,
    nextCursor: 'page-two',
    continuation: 'idle',
  })
  expect(html).toContain('Load more files')
})
