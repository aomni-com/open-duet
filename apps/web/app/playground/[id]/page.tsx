import { notFound } from 'next/navigation'

import { findPlaygroundEntry, PLAYGROUND_ENTRIES } from '../registry'
import { PlaygroundEntryContent } from './playground-entry-content'

export function generateStaticParams() {
  return PLAYGROUND_ENTRIES.map(entry => ({ id: entry.id }))
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const entry = findPlaygroundEntry(id)
  if (!entry) notFound()
  return <PlaygroundEntryContent id={entry.id} />
}
