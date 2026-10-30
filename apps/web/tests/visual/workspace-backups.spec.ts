import path from 'node:path'

import { expect, test } from '@playwright/test'

test('playground/workspace-backups exposes workspace export in a dedicated Backups tab', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/settings-default-tier-subscribed')
  await expect(page.locator('[data-default-tier-card]')).toBeVisible()
  await page.screenshot({
    path: path.join(
      process.cwd(),
      '../../specs/workspace-backup/assets',
      `settings-after-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  })
  await expect(page.locator('[data-backups-card]')).toHaveCount(0)
  await page.getByRole('link', { name: 'Backups', exact: true }).click()
  await expect(page.locator('[data-default-tier-card]')).toHaveCount(0)
  const card = page.locator('[data-backups-card]')
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(
      process.cwd(),
      '../../specs/workspace-backup/assets',
      `backups-tab-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  })
  await expect(card.getByRole('button', { name: 'Export workspace', exact: true })).toBeVisible()
})

test('playground/workspace-backups continues after leaving, mints fresh downloads, and waits for deletion', async ({
  page,
}) => {
  await page.route('**/playground/backup-download.zip?*', route =>
    route.fulfill({
      body: 'fixture archive',
      contentType: 'application/zip',
      headers: { 'content-disposition': 'attachment; filename="acme-workspace.zip"' },
    }),
  )
  await page.goto('/playground/workspace-backups-empty')
  const card = page.locator('[data-backups-card]')
  await card.getByRole('button', { name: 'Export workspace', exact: true }).click()
  await expect(card.getByText('Queued', { exact: true })).toBeVisible()
  await expect(
    card.getByText('You can leave this page. The backup will continue in the background.'),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Members', exact: true }).click()
  await page
    .getByRole('button', { name: 'Finish backup', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())
  const backupsTab = page.getByRole('link', { name: 'Backups', exact: true })
  await expect(backupsTab).toHaveCount(1)
  await backupsTab.click()
  await expect(card.getByText('Ready', { exact: true })).toBeVisible()
  for (const count of [1, 2]) {
    const transfer = page.waitForEvent('download')
    await card.getByRole('button', { name: 'Download', exact: true }).click()
    expect((await transfer).suggestedFilename()).toBe('acme-workspace.zip')
    await expect(page.getByTestId('backup-event')).toContainText(`"count":${count}`)
  }
  await card.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 3_000 })
  await card.getByRole('button', { name: 'Delete backup', exact: true }).click()
  await expect(card.getByText('Deleting', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Complete backup deletion', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(card.getByText('No backups yet. Your exports will appear here.')).toBeVisible()
})

test('playground/workspace-backups starts every overlapping download request', async ({ page }) => {
  await page.route('**/playground/backup-download.zip?*', route =>
    route.fulfill({
      body: 'archive',
      contentType: 'application/zip',
      headers: {
        'content-disposition': 'attachment; filename="acme-workspace.zip"',
      },
    }),
  )
  await page.goto('/playground/workspace-backups-ready')
  const downloads: string[] = []
  page.on('download', transfer => downloads.push(transfer.url()))
  await page
    .locator('[data-backups-card]')
    .getByRole('button', { name: 'Download', exact: true })
    .evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
  await expect(page.getByTestId('backup-event')).toContainText('"count":2')
  await expect.poll(() => downloads.length).toBe(2)
  expect(new Set(downloads).size).toBe(2)
})

test('playground/workspace-backups retries failed capture with a new job and replays a lost create response', async ({
  page,
}) => {
  await page.goto('/playground/workspace-backups-failed')
  const card = page.locator('[data-backups-card]')
  await card.getByRole('button', { name: 'Retry backup', exact: true }).click()
  await expect(card.locator('[data-backup-id="backup-created-1"]')).toContainText('Queued')
  await page.goto('/playground/workspace-backups-empty')
  await page
    .getByRole('button', { name: 'Lose next backup response', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())
  await card.getByRole('button', { name: 'Export workspace', exact: true }).click()
  await expect(card.getByRole('alert')).toBeVisible()
  const first = JSON.parse((await page.getByTestId('backup-event').textContent()) ?? '{}')
  await page
    .getByRole('button', { name: 'Finish backup', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(card.getByText('Ready', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(page.getByTestId('backup-event')).toContainText('"created":false')
  const retried = JSON.parse((await page.getByTestId('backup-event').textContent()) ?? '{}')
  expect(retried.requestId).toBe(first.requestId)
  expect(retried.backupId).toBe(first.backupId)
  await expect(card.locator('[data-backup-id]')).toHaveCount(1)
})

test('playground/workspace-backups-archived recovery deletion discloses the empty-Drive consequence', async ({
  page,
}) => {
  await page.goto('/playground/workspace-backups-archived')
  const card = page.locator('[data-backups-card]')
  await expect(card.getByRole('button', { name: 'Export workspace', exact: true })).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  await expect(card.getByText(/If you delete this archived workspace/)).toBeVisible()
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click()
  const wall = page.locator('[data-entitlement-wall]')
  await expect(wall).toBeVisible()
  const access = wall.getByRole('link', { name: 'Manage backups', exact: true })
  await access.scrollIntoViewIfNeeded()
  await expect(wall).toHaveScreenshot('workspace-backups-recovery-access.png')
  await access.click()
  await expect(wall).toHaveCount(0)
  await card.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 3_000 })
  await card.getByRole('button', { name: 'Delete backup', exact: true }).click()
  await expect(card.getByRole('status')).toContainText('empty Drive')
})
