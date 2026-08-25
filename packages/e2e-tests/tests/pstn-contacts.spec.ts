import { test, expect } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';
import { registerPasskey } from './lib/shell.ts';

/**
 * PSTN contacts panel UI gate. The CRUD wire is proved at the API tier; this
 * spec is the cheap CI regression gate that catches the panel never mounting,
 * the access kind regressing from `authed` to `public`, or the layout
 * breaking under a 350px viewport.
 */
test.describe('pstn-contacts — panel mounts behind sign-in', () => {
  test('an anonymous visitor to /pstn-contacts hits the sign-in gate', async ({ page }) => {
    await page.goto('/pstn-contacts');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.locator('[data-pstn-contacts-panel]')).toHaveCount(0);
  });

  test('signed-in browser sees the panel and the new-contact form', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await registerPasskey(page, 'pstn-tester');
    await expect(page.locator('[data-landing-app="tasks"]')).toBeVisible({ timeout: 10_000 });

    await page.goto('/pstn-contacts');
    const panel = page.locator('[data-pstn-contacts-panel]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('New contact')).toBeVisible();
    await expect(panel.locator('[data-action="pstn-contacts:create"]')).toBeVisible();
    await expect(panel.locator('[data-pstn-empty]')).toBeVisible();
  });

  test('the panel fits a 350px viewport with no horizontal overflow', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.setViewportSize({ width: 350, height: 800 });
    await page.goto('/');
    await registerPasskey(page, 'pstn-narrow');
    await expect(page.locator('[data-landing-app="tasks"]')).toBeVisible({ timeout: 10_000 });

    await page.goto('/pstn-contacts');
    const panel = page.locator('[data-pstn-contacts-panel]');
    await expect(panel).toBeVisible();

    // The panel must not cause the document to scroll horizontally at 350px.
    const overflows = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflows).toBe(false);
  });
});
