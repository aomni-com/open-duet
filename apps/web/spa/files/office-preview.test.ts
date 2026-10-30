import { describe, expect, test } from 'bun:test'

import { officeKind } from './office-preview'
import {
  compactSpreadsheetCellPreview,
  parseWorkbook,
  spreadsheetColumnLabel,
} from './spreadsheet-preview'

describe('office preview parsing', () => {
  test('classifies supported office formats without treating legacy formats as renderable', () => {
    expect(officeKind('report.xlsx')).toBe('spreadsheet')
    expect(officeKind('REPORT.ODS')).toBe('spreadsheet')
    expect(officeKind('brief.docx')).toBe('word')
    expect(officeKind('deck.pptx')).toBe('presentation')
    expect(officeKind('legacy.doc')).toBe('fallback')
    expect(officeKind('slides.key')).toBe('fallback')
  })

  test('parses CSV bytes into worksheet values and rejects empty bytes', () => {
    const parsed = parseWorkbook(
      new TextEncoder().encode('Plan,Owner,Status\nAPI docs,Maya,Ready\n'),
    )
    expect(parsed).toEqual({
      ok: true,
      sheets: [
        {
          name: 'Sheet1',
          rows: [
            ['Plan', 'Owner', 'Status'],
            ['API docs', 'Maya', 'Ready'],
          ],
        },
      ],
    })
    expect(parseWorkbook(new Uint8Array())).toEqual({ ok: false })
  })

  test('labels spreadsheet columns beyond Z without losing coordinates', () => {
    expect([0, 25, 26, 49].map(spreadsheetColumnLabel)).toEqual(['A', 'Z', 'AA', 'AX'])
  })

  test('previews long mobile cells at a word boundary', () => {
    expect(
      compactSpreadsheetCellPreview(
        'A deliberately long handoff note that remains readable instead of disappearing.',
      ),
    ).toBe('A deliberately long…')
    expect(compactSpreadsheetCellPreview('Ready')).toBe('Ready')
  })
})
