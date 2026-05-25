import { test, expect } from '@playwright/test';

/**
 * Showcase public-app verification — the boundary the unit and browser tiers
 * cannot reach: a real, anonymous HTTP visit. A signed-out visitor must be
 * served the SPA shell for `/showcase` and watch the catalogue render with no
 * sign-in gate, while the authed apps stay gated. This exercises the public
 * carve-out end to end: `isPublicPath` serving the shell, the router resolving
 * `/showcase`, and `access: 'public'` rendering it without a session.
 */
test.describe('showcase — a public, web-only app', () => {
  test('an anonymous visitor sees the showcase, not the sign-in gate', async ({ page }) => {
    await page.goto('/showcase');
    await expect(page.locator('[data-showcase-panel]')).toBeVisible();
    await expect(page.locator('[data-sign-in]')).toHaveCount(0);
  });

  test('the catalogue renders component sections', async ({ page }) => {
    await page.goto('/showcase');
    await expect(page.locator('#badge')).toBeVisible();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#toast')).toBeVisible();
  });

  test('an authed app stays gated for an anonymous visitor', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.locator('[data-tasks-panel]')).toHaveCount(0);
  });

  test('the catalogue fits a 350px viewport with no horizontal overflow', async ({ page }) => {
    // 350px is eal's hard floor — the smallest phone the app must serve.
    await page.setViewportSize({ width: 350, height: 900 });
    await page.goto('/showcase');
    await expect(page.locator('[data-showcase-panel]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
