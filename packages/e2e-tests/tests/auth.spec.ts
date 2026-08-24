import { test, expect, type Page } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';
import { expectSignedInAs, expectSignedOut } from './lib/shell.ts';

/** Sign out — the control lives in the nav drawer, behind the Menu button. */
async function signOutViaDrawer(page: Page): Promise<void> {
  await page.locator('[data-action="shell:nav-toggle"]').click();
  await page.locator('[data-action="auth:sign-out"]').click();
}

test.describe('day-one auth e2e', () => {
  test('GET /api/v1/auth/me returns 401 without a token', async ({ request }) => {
    const response = await request.get('/api/v1/auth/me');
    expect(response.status()).toBe(401);
  });

  test('no-auth SPA visibility: anonymous user sees the sign-in surface', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expectSignedOut(page);
  });

  test('full passkey register → land on app authenticated', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await expect(page.locator('[data-sign-in]')).toBeVisible();

    await page.locator('input[name="displayName"]').fill('alex');
    await page.locator('[data-action="auth:register"]').click();

    await expectSignedInAs(page, 'alex');
    await expect(page.locator('[data-sign-in]')).toHaveCount(0);
    // Sign-out lives in the nav drawer — open it to confirm it's reachable.
    await page.locator('[data-action="shell:nav-toggle"]').click();
    await expect(page.locator('[data-sign-out]')).toBeVisible();
  });

  test('register → sign out → sign in with the same passkey lands authenticated', async ({ page }) => {
    // The bug this regression-tests: at registration we don't pass a userID,
    // so @simplewebauthn generates random bytes; the browser returns those
    // bytes as `userHandle` on subsequent sign-in. Earlier the wrapper tried
    // to decode userHandle as a decimal user id — guaranteed to fail. Now we
    // look the user up by credential id; userHandle is auxiliary.
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await page.locator('input[name="displayName"]').fill('returner');
    await page.locator('[data-action="auth:register"]').click();
    await expectSignedInAs(page, 'returner');

    await signOutViaDrawer(page);
    await expect(page.locator('[data-sign-in]')).toBeVisible({ timeout: 10_000 });

    // No display name needed on sign-in — discoverable credential surfaces it.
    await page.locator('[data-action="auth:sign-in"]').click();
    await expectSignedInAs(page, 'returner');
  });

  test('sign-out returns to the sign-in surface', async ({ page }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await page.locator('input[name="displayName"]').fill('leo');
    await page.locator('[data-action="auth:register"]').click();
    await expectSignedInAs(page, 'leo');

    await signOutViaDrawer(page);
    await expect(page.locator('[data-sign-in]')).toBeVisible({ timeout: 10_000 });
    await expectSignedOut(page);
  });

  test('authed POST to /api/v1/tasks broadcasts to the signed-in SPA', async ({ page, request }) => {
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await page.locator('input[name="displayName"]').fill('elisa');
    await page.locator('[data-action="auth:register"]').click();
    await expectSignedInAs(page, 'elisa');

    // The shell lands on the launcher — open the Tasks app to see task rows.
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await expect(page.locator('[data-tasks-panel]')).toBeVisible();

    // Use the same token the SPA just stored.
    const token = await page.evaluate(() => localStorage.getItem('eal-token'));
    expect(token).not.toBeNull();
    const post = await request.post('/api/v1/tasks', {
      data: { title: 'pick up parcel' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(post.status()).toBe(200);

    await page.waitForFunction(
      () => {
        const els = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
        return els.some((el) => (el.textContent ?? '').trim() === 'pick up parcel');
      },
      undefined,
      { timeout: 5_000 },
    );
  });
});
