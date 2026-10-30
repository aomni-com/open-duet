import { expect, test } from '@playwright/test'

/* The composer takes a batch, and the picker and the clipboard are two ways to
   hand it one. Both have been single-file at some point — the picker because a
   fixture opted out of `multiple`, the clipboard because pasted files were
   dropped outright — so each route is driven here rather than inferred from
   the markup. */

test('playground/compose-bar attaches every file picked in one trip', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  /* setInputFiles refuses a list against an input that is not `multiple`, so
     this fails at the picker before it ever reaches the cards. */
  await page.locator('form input[type="file"]').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from('beta') },
    { name: 'gamma.txt', mimeType: 'text/plain', buffer: Buffer.from('gamma') },
  ])

  const form = page.locator('form')
  await expect(form.getByText('alpha.txt')).toBeVisible()
  await expect(form.getByText('beta.txt')).toBeVisible()
  await expect(form.getByText('gamma.txt')).toBeVisible()
})

test('playground/compose-bar attaches files pasted into the editor', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.locator('[data-compose-bar-editor]').evaluate(editor => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['shot one'], 'screenshot-1.png', { type: 'image/png' }))
    transfer.items.add(new File(['shot two'], 'screenshot-2.png', { type: 'image/png' }))
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })

  const form = page.locator('form')
  await expect(form.getByText('screenshot-1.png')).toBeVisible()
  await expect(form.getByText('screenshot-2.png')).toBeVisible()
})

test('playground/compose-bar keeps the words when a paste carries both', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const editor = page.locator('[data-compose-bar-editor]')
  await editor.click()
  await editor.evaluate(node => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['chart'], 'chart.png', { type: 'image/png' }))
    transfer.setData('text/plain', 'Quarterly numbers')
    node.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })

  await expect(page.locator('form').getByText('chart.png')).toBeVisible()
  await expect(editor).toContainText('Quarterly numbers')
})
