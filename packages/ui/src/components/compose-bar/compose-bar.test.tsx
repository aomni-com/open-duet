import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { TooltipProvider } from '../shadcn/tooltip'
import { ComposeBar } from './compose-bar'

const pickerLabels = {
  list: 'Suggestions',
  loading: 'Loading',
  empty: 'No suggestions',
  unavailable: 'Suggestions unavailable',
}

/** The opening tag of the first button whose accessible name is `label`. */
function buttonNamed(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`)
  expect(at).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<button', at)
  return html.slice(start, html.indexOf('>', at))
}

const composeBarProps = {
  value: 'Draft for the next message',
  onValueChange: () => {},
  onSubmit: () => {},
  input: { label: 'Message Duet' },
  attachments: { items: [], onFilesSelected: () => true, fileInput: { label: 'Attach' } },
  skills: { items: [], labels: pickerLabels },
  agents: { items: [], labels: pickerLabels },
}

test('a send in flight holds only Send; the rest of the composer keeps working', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ComposeBar {...composeBarProps} submitting />
    </TooltipProvider>,
  )

  expect(buttonNamed(html, 'Sending message')).toContain('disabled=""')
  expect(buttonNamed(html, 'Attach')).not.toContain('disabled=""')
  expect(html).not.toMatch(/<input[^>]*type="file"[^>]*disabled=""/)
})

test('a disabled composer still disables everything', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ComposeBar {...composeBarProps} disabled />
    </TooltipProvider>,
  )

  expect(buttonNamed(html, 'Send message')).toContain('disabled=""')
  expect(buttonNamed(html, 'Attach')).toContain('disabled=""')
})
