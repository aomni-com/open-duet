import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { attachmentPreview } from './compose-bar-attachment'

test('fits image previews inside attachment cards without cropping', () => {
  const html = renderToStaticMarkup(
    <>
      {attachmentPreview({
        id: 'portrait',
        name: 'portrait.png',
        preview: { kind: 'image', src: 'blob:portrait' },
      })}
    </>,
  )

  expect(html).toContain('bg-contain')
  expect(html).not.toContain('bg-cover')
})
