import { test, expect } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';
import { registerPasskey } from './lib/shell.ts';

/**
 * Agent-rules panel UI gate. The rule lifecycle and broadcast convergence are
 * proved in scripts/e2e-rules-multi.ts; this spec is the cheap CI regression
 * gate that catches the panel never mounting or the access kind regressing
 * from `authed` to `public`.
 */
test.describe('agent-rules — panel mounts behind sign-in', () => {
  test('an anonymous visitor to /agent-rules hits the sign-in gate', async ({ page }) => {
    await page.goto('/agent-rules');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.locator('[data-agent-rules-panel]')).toHaveCount(0);
  });

  test('signed-in browser sees the panel and the new-rule form', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await registerPasskey(page, 'rules-tester');
    await expect(page.locator('[data-landing-app="tasks"]')).toBeVisible({ timeout: 10_000 });

    await page.goto('/agent-rules');
    const panel = page.locator('[data-agent-rules-panel]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('New proactivity rule')).toBeVisible();
    await expect(panel.locator('[data-action="agent-rules:create"]')).toBeVisible();
  });
});
