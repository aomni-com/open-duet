'use client'

import { PlaygroundShell } from '../components/playground-shell'
import type { PlaygroundId } from '../registry'
import { PLAYGROUND_RENDERERS } from '../render-map'

export function PlaygroundEntryContent({
  id,
  presentation,
}: {
  id: PlaygroundId
  presentation: 'landing' | 'plain'
}) {
  const render = PLAYGROUND_RENDERERS[id]
  return <PlaygroundShell presentation={presentation}>{render()}</PlaygroundShell>
}
