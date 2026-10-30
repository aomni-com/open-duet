'use client'

import { CaretDownIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import * as XLSX from 'xlsx'

import { Button } from '@repo/ui/components/shadcn/button'

import { OfficeFallback } from './office-preview'

export function SpreadsheetPreview({
  bytes,
  fileName,
  downloadUrl,
}: {
  bytes: Uint8Array
  fileName: string
  downloadUrl: string
}) {
  const t = useTranslations('duetApp.filesSurface.spreadsheet')
  const parsed = useMemo(() => parseWorkbook(bytes), [bytes])
  const tabSetId = useId()
  const [sheetIndex, setSheetIndex] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const measureOverflow = useCallback(() => {
    const element = viewport.current
    if (element === null) return
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
    setOverflow({
      left: element.scrollLeft > 2,
      right: element.scrollLeft < maxScroll - 2,
    })
  }, [])
  useEffect(() => {
    setSheetIndex(current =>
      Math.min(current, Math.max(0, parsed.ok ? parsed.sheets.length - 1 : 0)),
    )
  }, [parsed])
  const sheets = parsed.ok ? parsed.sheets : []
  const sheet = sheets[sheetIndex]
  const columnCount = Math.max(0, ...(sheet?.rows.map(row => row.length) ?? []))
  const panelId = `${tabSetId}-sheet-${sheetIndex}`
  useEffect(() => {
    const element = viewport.current
    if (element === null) return
    element.scrollLeft = 0
    measureOverflow()
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(element)
    return () => observer.disconnect()
  }, [columnCount, measureOverflow, sheetIndex])
  if (!parsed.ok) return <OfficeFallback fileName={fileName} downloadUrl={downloadUrl} />
  const selectSheetFromKeyboard = (event: KeyboardEvent, index: number) => {
    const lastIndex = parsed.sheets.length - 1
    const nextIndex =
      event.key === 'ArrowRight'
        ? index === lastIndex
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? lastIndex
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? lastIndex
              : null
    if (nextIndex === null) return
    event.preventDefault()
    setSheetIndex(nextIndex)
    document.getElementById(`${tabSetId}-tab-${nextIndex}`)?.focus()
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {parsed.sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label={t('sheets')}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 bg-muted/30 p-2"
        >
          {parsed.sheets.map((item, index) => (
            <Button
              key={item.name}
              role="tab"
              id={`${tabSetId}-tab-${index}`}
              aria-selected={sheetIndex === index}
              aria-controls={`${tabSetId}-sheet-${index}`}
              tabIndex={sheetIndex === index ? 0 : -1}
              size="sm"
              className="min-h-11 sm:min-h-8"
              variant={sheetIndex === index ? 'secondary' : 'ghost'}
              onClick={() => setSheetIndex(index)}
              onKeyDown={event => selectSheetFromKeyboard(event, index)}
            >
              {item.name}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={parsed.sheets.length > 1 ? `${tabSetId}-tab-${sheetIndex}` : undefined}
        className="relative min-h-0 flex-auto overflow-hidden bg-background"
      >
        <div
          ref={viewport}
          onScroll={measureOverflow}
          className="h-full overflow-auto overscroll-contain"
        >
          <table className="w-max min-w-full border-collapse bg-background text-[13px] sm:text-xs">
            <caption className="sr-only">{t('sheetLabel', { name: sheet?.name ?? '' })}</caption>
            <thead>
              <tr>
                <th
                  aria-label={t('rowNumbers')}
                  className="sticky left-0 top-0 z-20 size-8 border border-border bg-muted/70"
                />
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <th
                    key={columnIndex}
                    scope="col"
                    className="sticky top-0 z-10 w-24 min-w-24 max-w-24 border border-border bg-muted/70 px-2 py-1.5 text-center font-medium text-muted-foreground sm:w-auto sm:min-w-28 sm:max-w-none"
                  >
                    {spreadsheetColumnLabel(columnIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet?.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="transition-colors hover:bg-muted/25">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border border-border bg-muted/55 px-2 py-1.5 text-right align-top font-normal tabular-nums text-muted-foreground"
                  >
                    {rowIndex + 1}
                  </th>
                  {row.map((cell, columnIndex) => (
                    <td
                      key={columnIndex}
                      aria-label={cell.length > 32 ? cell : undefined}
                      className="w-24 min-w-24 max-w-24 border border-border px-2 py-1.5 align-top sm:w-auto sm:min-w-28 sm:max-w-72"
                    >
                      <span
                        tabIndex={cell.length > 32 ? 0 : undefined}
                        title={cell.length > 32 ? cell : undefined}
                        className={`group block max-h-10 overflow-hidden whitespace-pre-wrap break-words leading-5 outline-none focus:max-h-none focus:overflow-visible focus:rounded-sm focus:bg-muted/60 focus:ring-2 focus:ring-ring/50 ${
                          cell.length > 32 ? 'relative' : ''
                        }`}
                      >
                        {cell.length > 32 ? (
                          <>
                            <span className="block text-xs tracking-tight group-focus:hidden sm:hidden">
                              {compactSpreadsheetCellPreview(cell)}
                            </span>
                            <span className="hidden group-focus:inline sm:inline">{cell}</span>
                            <span
                              aria-hidden
                              className="absolute bottom-0 right-0 grid size-4 place-items-center rounded-sm bg-background text-muted-foreground group-focus:hidden sm:hidden"
                            >
                              <CaretDownIcon className="size-3" />
                            </span>
                          </>
                        ) : (
                          cell
                        )}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {overflow.left ? (
          <span
            aria-hidden
            data-spreadsheet-overflow="left"
            className="pointer-events-none absolute inset-y-0 left-0 z-30 w-8 bg-gradient-to-r from-background via-background/75 to-transparent"
          />
        ) : null}
        {overflow.right ? (
          <span
            aria-hidden
            data-spreadsheet-overflow="right"
            className="pointer-events-none absolute inset-y-0 right-0 z-30 w-10 bg-gradient-to-l from-background via-background/75 to-transparent"
          />
        ) : null}
      </div>
    </div>
  )
}

export function spreadsheetColumnLabel(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

export function compactSpreadsheetCellPreview(value: string): string {
  const maxCharacters = 22
  const source = value.trim()
  if (source.length <= maxCharacters) return source
  const boundary = source.lastIndexOf(' ', maxCharacters - 1)
  const end = boundary >= 8 ? boundary : maxCharacters - 1
  return `${source.slice(0, end).trimEnd()}…`
}

export function parseWorkbook(
  bytes: Uint8Array,
): { ok: true; sheets: Array<{ name: string; rows: string[][] }> } | { ok: false } {
  if (bytes.byteLength === 0) return { ok: false }
  try {
    const workbook = XLSX.read(bytes, {
      type: 'array',
      cellDates: true,
      cellFormula: true,
      dense: true,
      sheetRows: 1_001,
    })
    return {
      ok: true,
      sheets: workbook.SheetNames.map(name => ({
        name,
        rows: (
          XLSX.utils.sheet_to_json(workbook.Sheets[name]!, { header: 1, raw: false }) as unknown[][]
        )
          .slice(0, 1_000)
          .map(row => row.slice(0, 50).map(value => (value == null ? '' : String(value)))),
      })),
    }
  } catch {
    return { ok: false }
  }
}
