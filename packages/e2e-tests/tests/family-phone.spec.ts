import { test, expect } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';

/**
 * Family-phone panel UI gate. Single browser, real api — closes the loop on
 * panel rendering, the pair-first notice, the diagnostics surface, and the
 * call directory. Audio capture and the call accept/audio/hangup wire path
 * are exercised by scripts/e2e-family-phone-call.ts and
 * scripts/e2e-agent-voice-call.ts; this spec is the cheap regression gate
 * the multi tier doesn't cover.
 */
test.describe('family-phone — panel mounts and reacts to pair state', () => {
  test('an anonymous visitor to /family-phone hits the sign-in gate', async ({ page }) => {
    await page.goto('/family-phone');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.locator('[data-family-phone-panel]')).toHaveCount(0);
  });

  test('signed-in but unpaired browser sees the panel + PairFirstNotice', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await page.locator('input[name="displayName"]').fill('phone-tester');
    await page.locator('[data-action="auth:register"]').click();
    await expect(page.locator('[data-landing-app="tasks"]')).toBeVisible({ timeout: 10_000 });

    await page.goto('/family-phone');
    const panel = page.locator('[data-family-phone-panel]');
    await expect(panel).toBeVisible();

    // PairFirstNotice surfaces because this browser hasn't paired into the
    // household; the "Go to Devices" anchor is the documented next step.
    await expect(panel.getByText('This browser is not paired')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Go to Devices' })).toBeVisible();

    // The diagnostics card renders unconditionally and offers the three checks.
    await expect(panel.locator('[data-action="family-phone:sound-check"]')).toBeVisible();
    await expect(panel.locator('[data-action="family-phone:mic-check"]')).toBeVisible();
    await expect(panel.locator('[data-action="family-phone:permissions-check"]')).toBeVisible();
  });

  test('the panel fits a 350px viewport with no horizontal overflow', async ({ page }) => {
    // 350px is eal's hard floor — the smallest phone the app must serve.
    await attachVirtualAuthenticator(page);
    await page.setViewportSize({ width: 350, height: 900 });
    await page.goto('/');
    await page.locator('input[name="displayName"]').fill('phone-narrow');
    await page.locator('[data-action="auth:register"]').click();
    await expect(page.locator('[data-landing-app="tasks"]')).toBeVisible({ timeout: 10_000 });

    await page.goto('/family-phone');
    await expect(page.locator('[data-family-phone-panel]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
