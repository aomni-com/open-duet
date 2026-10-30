import { expect, test } from '@playwright/test'

import { DOCS_VISUAL_ROUTES } from './registry'

/** Chromium's GPU tile limit: taller full-page captures are stitched. */
const MAX_CAPTURE_HEIGHT = 16_384

for (const entry of DOCS_VISUAL_ROUTES) {
  test(`docs/${entry.visualId}`, async ({ page }, testInfo) => {
    await page.goto(entry.captureRoute)
    await expect(page.locator('h1')).toBeVisible()

    if (testInfo.project.name === 'mobile') {
      await expect(page.getByText('Browse documentation')).toBeVisible()
      if (entry.visualId === 'docs-getting-started') {
        await page.getByText('Browse documentation').click()
        await expect(page.locator('.mobile-nav')).toHaveAttribute('open', '')
        await expect(page.getByRole('navigation', { name: 'Documentation' }).last()).toBeVisible()
        await page.getByText('Browse documentation').click()
        await expect(page.locator('h1')).toBeInViewport()
        await page.getByText('Browse documentation').click()
        await expect(page.locator('.mobile-nav')).toHaveAttribute('open', '')
      }
    } else {
      await expect(page.getByRole('navigation', { name: 'Documentation' }).first()).toBeVisible()
    }
    if (entry.visualId === 'docs-reliability' || entry.visualId === 'docs-mirror-devices') {
      const obscured = await page.locator('.code-block').evaluateAll(blocks =>
        blocks.flatMap(block => {
          const button = block.querySelector('button')
          const pre = block.querySelector('pre')
          if (!button || !pre)
            throw new Error('Code example is missing its copy control or content')
          return button.getBoundingClientRect().bottom > pre.getBoundingClientRect().top
            ? [pre.textContent]
            : []
        }),
      )
      expect(obscured, 'copy controls must not cover example content').toEqual([])
      if (testInfo.project.name === 'mobile') {
        const broken = await page.locator('.code-block pre').evaluateAll(blocks => {
          const words: string[] = []
          for (const block of blocks) {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
            let node: Node | null
            while ((node = walker.nextNode())) {
              for (const match of (node.textContent ?? '').matchAll(
                /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g,
              )) {
                const range = document.createRange()
                range.setStart(node, match.index!)
                range.setEnd(node, match.index! + match[0].length)
                if (range.getClientRects().length > 1) words.push(match[0])
              }
            }
          }
          return words
        })
        expect(broken, 'display wrapping must keep identifiers and words intact').toEqual([])
      }
      for (const block of await page.locator('.code-block pre').all()) {
        if (!(await block.evaluate(element => element.scrollWidth > element.clientWidth))) continue
        await expect(
          block.locator('..').getByText('Scroll horizontally to see the full line.'),
        ).toBeVisible()
        await block.focus()
        await page.keyboard.press('ArrowRight')
        await expect.poll(() => block.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
        await block.evaluate(element => {
          element.scrollLeft = 0
        })
      }
      await page.evaluate(() => {
        ;(document.activeElement as HTMLElement)?.blur()
        window.scrollTo({ top: 0, behavior: 'instant' })
      })
    }
    if (entry.visualId === 'docs-getting-started' && testInfo.project.name === 'desktop') {
      const sidebar = page.locator('.sidebar')
      await sidebar.hover()
      await page.mouse.wheel(0, 500)
      await expect
        .poll(() => sidebar.evaluate(element => element.scrollTop), {
          message: 'desktop documentation sidebar must scroll independently',
        })
        .toBeGreaterThan(0)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      await sidebar.evaluate(element => {
        element.scrollTop = 0
      })
      const example = await page.locator('.code-block pre').first().textContent()
      await page.getByRole('button', { name: 'Copy' }).first().click()
      await expect(page.getByRole('button', { name: 'Copied' }).first()).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(example)
    }
    await page.evaluate(() => {
      document.querySelectorAll('nextjs-portal').forEach(element => element.remove())
    })

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${entry.visualId} must not overflow horizontally`,
    ).toBe(true)
    /* Full page, up to Chromium's tile height. Past it a full-page capture is
       stitched, and on the API reference (over sixty thousand pixels) the
       stitch came back a few hundred pixels short on alternate frames while
       the page itself held one height, so the gate could never get two equal
       shots. Every other page fits under the cap whole; the reference keeps
       its first sixteen thousand pixels, which already hold every kind of
       endpoint card it draws. */
    const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    await expect(page).toHaveScreenshot(`${entry.visualId}.png`, {
      fullPage: true,
      clip: {
        x: 0,
        y: 0,
        width: page.viewportSize()?.width ?? 1440,
        height: Math.min(documentHeight, MAX_CAPTURE_HEIGHT),
      },
      timeout: 15_000,
    })
  })
}
