import { expect, type Page } from '@playwright/test';

/**
 * Who the shell thinks you are is shown in one place only: a badge inside the
 * nav drawer (`web/src/shell/nav-drawer.tsx`). The drawer is a Modal, closed
 * until the top bar's Menu button opens it, so `[data-current-user]` is absent
 * from the page — signed in or not — while it stays shut. The Menu button
 * itself only renders for a signed-in session (`shell/app.tsx`).
 *
 * These helpers open the drawer, assert against it, and close it again, so a
 * caller can carry on driving the page underneath.
 */

const SIGN_IN_TIMEOUT_MS = 10_000;

/**
 * The invite code the webServer in `playwright.config.ts` configures. The api
 * refuses registration outright without one (packages/api/src/auth/registration.ts),
 * so every spec that registers a passkey has to present it.
 */
export const E2E_INVITE_CODE = 'playwright-invite-code-0123456789';

/**
 * Fill the sign-in card and start the passkey ceremony. The caller must have
 * attached a virtual authenticator first, and asserts the outcome itself —
 * usually with `expectSignedInAs`.
 */
export async function registerPasskey(page: Page, displayName: string): Promise<void> {
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('input[name="inviteCode"]').fill(E2E_INVITE_CODE);
  await page.locator('[data-action="auth:register"]').click();
}

/** Open the drawer, assert the signed-in badge reads `displayName`, close it. */
export async function expectSignedInAs(page: Page, displayName: string): Promise<void> {
  // The Menu button appears with the session, so this click also waits out the
  // passkey ceremony the caller has just started.
  await page.locator('[data-action="shell:nav-toggle"]').click({ timeout: SIGN_IN_TIMEOUT_MS });
  await expect(page.locator('[data-current-user]')).toHaveText(displayName, {
    timeout: SIGN_IN_TIMEOUT_MS,
  });
  await closeDrawer(page);
}

/**
 * Assert no session: the top bar offers no Menu button, so there is no drawer
 * to open and no badge anywhere in the page.
 */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.locator('[data-action="shell:nav-toggle"]')).toHaveCount(0);
  await expect(page.locator('[data-current-user]')).toHaveCount(0);
}

/**
 * Dismiss the drawer through its backdrop and wait for it to leave the DOM.
 * The event is dispatched rather than clicked because the drawer panel covers
 * the middle of the backdrop it sits on.
 */
async function closeDrawer(page: Page): Promise<void> {
  await page.locator('[data-polly-modal-backdrop]').dispatchEvent('click');
  await expect(page.locator('[data-app-nav]')).toHaveCount(0);
}
