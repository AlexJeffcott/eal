import { delay } from '@eal/shared';
import type { Page } from 'puppeteer';

export const POLL_INTERVAL_MS = Number(process.env['EAL_POLL_MS'] ?? '200');
export const SHORT_TIMEOUT_MS = Number(process.env['EAL_SHORT_TIMEOUT_MS'] ?? '5000');
export const NAV_TIMEOUT_MS = Number(process.env['EAL_NAV_TIMEOUT_MS'] ?? '15000');

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? SHORT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }

  const desc = opts.description ?? 'condition';
  throw new Error(`waitFor: ${desc} did not become truthy within ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

export async function waitForText(page: Page, text: string, timeoutMs: number = SHORT_TIMEOUT_MS): Promise<void> {
  await waitFor(
    async () => {
      const body = await page.evaluate(() => document.body.innerText);
      return body.includes(text);
    },
    { timeoutMs, description: `text "${text}"` },
  );
}

/**
 * Wait until the shell shows `displayName` as the signed-in user.
 *
 * The badge lives in the nav drawer (`web/src/shell/nav-drawer.tsx`), which is
 * a Modal the shell keeps closed, so the name is in no page text until the
 * drawer opens. The Menu button that opens it renders only for a signed-in
 * session, so the click waits out the passkey ceremony too. Close the drawer
 * again afterwards, so the caller gets the page back the way it found it.
 */
export async function waitForSignedInAs(
  page: Page,
  displayName: string,
  timeoutMs: number = SHORT_TIMEOUT_MS,
): Promise<void> {
  await page.locator('[data-action="shell:nav-toggle"]').click();
  await waitFor(
    async () => {
      const badge = await page.evaluate(
        () => document.querySelector('[data-current-user]')?.textContent ?? '',
      );
      return badge.includes(displayName);
    },
    { timeoutMs, description: `signed in as "${displayName}"` },
  );
  // Dismiss through the backdrop, the same path `nav.browser.tsx` drives. The
  // drawer panel covers the middle of the backdrop, so click it in the DOM
  // rather than aiming a pointer at it.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-polly-modal-backdrop]')?.click();
  });
  await waitFor(
    async () => await page.evaluate(() => document.querySelector('[data-app-nav]') === null),
    { description: 'nav drawer closed' },
  );
}
