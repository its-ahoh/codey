import { test, expect } from './fixtures'

test('opens the main window', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'New chat ⌘N' })).toBeVisible()
})

test('opens Settings', async ({ page }) => {
  await page.getByText('Settings', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'General' })).toBeVisible()
})

test('opens Tools', async ({ page }) => {
  await page.getByText('Tools', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Add skill' })).toBeVisible()
})
