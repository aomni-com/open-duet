import { describe, expect, test } from 'bun:test'

import { Robot } from '@phosphor-icons/react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DriveShell, DriveTabPanel, DriveTopBar, type DriveTopBarTab } from './drive-shell'
import { rovingTabIndexForKey } from './tab-keyboard'

const tabs: readonly DriveTopBarTab[] = [
  { value: 'agents', label: 'Agents', icon: Robot },
  { value: 'files', label: 'Drive', icon: Robot },
  { value: 'integrations', label: 'Integrations', icon: Robot },
]

describe('Drive shell', () => {
  test('renders controlled tabs with matching ARIA tab-panel relationships', () => {
    const html = renderToStaticMarkup(
      <DriveShell
        bottomLeft={<span>Account footer</span>}
        topBar={
          <DriveTopBar
            tabs={tabs}
            activeTab="files"
            onSelectTab={() => undefined}
            leftSlot={<button>Acme workspace</button>}
            rightSlot={<button>Walter account</button>}
            label="Workspace sections"
          />
        }
      >
        <DriveTabPanel value="files" activeTab="files">
          Files panel
        </DriveTabPanel>
      </DriveShell>,
    )

    expect(html).toContain('data-drive-shell="true"')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Workspace sections"')
    expect(html).toContain('id="drive-tab-files"')
    expect(html).toContain('aria-controls="drive-panel-files"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('id="drive-panel-files"')
    expect(html).toContain('aria-labelledby="drive-tab-files"')
    expect(html).toContain('data-drive-topbar-slot="left"')
    expect(html).toContain('data-drive-topbar-slot="right"')
    expect(html).toContain('data-drive-bottom-left="true"')
    expect(html).toContain('Account footer')
    expect(html.match(/flex-1 basis-0/g)?.length).toBe(2)
  })

  test('keeps only the selected tab in the roving sequence', () => {
    const html = renderToStaticMarkup(
      <DriveTopBar
        tabs={tabs}
        activeTab="integrations"
        onSelectTab={() => undefined}
        leftSlot={null}
        rightSlot={null}
        label="Workspace sections"
      />,
    )

    const renderedTabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(match => match[0])
    expect(renderedTabs).toHaveLength(3)
    for (const [index, tab] of tabs.entries()) {
      expect(renderedTabs[index]).toContain(`id="drive-tab-${tab.value}"`)
      expect(renderedTabs[index]).toContain(`tabindex="${tab.value === 'integrations' ? 0 : -1}"`)
      expect(renderedTabs[index]).toContain(`aria-selected="${tab.value === 'integrations'}"`)
    }
  })

  test('maps tab keys to wrapped destinations and ignores unrelated keys', () => {
    expect(rovingTabIndexForKey('ArrowRight', 4, 5)).toBe(0)
    expect(rovingTabIndexForKey('ArrowLeft', 0, 5)).toBe(4)
    expect(rovingTabIndexForKey('ArrowDown', 1, 5)).toBe(2)
    expect(rovingTabIndexForKey('ArrowUp', 1, 5)).toBe(0)
    expect(rovingTabIndexForKey('Home', 2, 5)).toBe(0)
    expect(rovingTabIndexForKey('End', 1, 5)).toBe(4)
    expect(rovingTabIndexForKey('Enter', 1, 5)).toBeNull()
  })
})
