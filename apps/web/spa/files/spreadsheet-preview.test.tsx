import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../messages/en/app.json'
import { SpreadsheetPreview } from './spreadsheet-preview'

test('an unreadable workbook offers the original file instead of a blank preview', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <SpreadsheetPreview
        bytes={new Uint8Array()}
        fileName="broken.xlsx"
        downloadUrl="/broken.xlsx"
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Preview unavailable')
  expect(html).toContain('download="broken.xlsx"')
})
