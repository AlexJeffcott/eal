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
