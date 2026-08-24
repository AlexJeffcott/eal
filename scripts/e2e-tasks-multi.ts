#!/usr/bin/env bun
/**
 * Cross-boundary multi-device test for tasks.
 *
 * Two real Chromium browsers, both signed in as members of the same household.
 * Mutations made in one browser must propagate to the other via the WS broadcast.
 * Mirrors the shape of e2e-hello-multi.ts so the same invariants are proved for
 * the feature that replaced greetings.
 *
 *   Browser A creates a task     → broadcast → Browser B sees the row.
 *   Browser B completes the task → broadcast → Browser A sees the strike-through.
 *   Browser A deletes the task   → broadcast → Browser B sees it leave Inbox.
 *   Both switch to Trash         → Browser B sees the deleted row with Restore.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/tasks-multi');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'tasks-multi.sqlite');
const TOKEN_HOME = resolve(ARTIFACTS, 'cli-home');
const TOKEN_PATH = resolve(TOKEN_HOME, 'token');
const FIXED_PORT = '4106';

async function captureScreenshots(browsers: Browser[], suffix: string): Promise<void> {
  for (let i = 0; i < browsers.length; i++) {
    const browser = browsers[i];
    if (!browser) continue;
    const pages = await browser.pages().catch(() => []);
    for (let j = 0; j < pages.length; j++) {
      const page = pages[j];
      if (!page) continue;
      await page
        .screenshot({ path: resolve(ARTIFACTS, `device-${i}-page-${j}-${suffix}.png`), fullPage: true })
        .catch(() => {});
    }
  }
}

async function waitForRowWithTitle(page: Page, title: string, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (needle) => {
      const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
      return rows.some((el) => (el.textContent ?? '').trim() === needle);
    },
    { timeout: timeoutMs },
    title,
  );
}

async function waitForRowStatus(
  page: Page,
  title: string,
  status: 'open' | 'done',
  timeoutMs = 10_000,
): Promise<void> {
  await page.waitForFunction(
    (needle, expected) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]'));
      return rows.some((row) => {
        const t = row.querySelector('[data-task-title]')?.textContent?.trim();
        return t === needle && row.dataset['taskStatus'] === expected;
      });
    },
    { timeout: timeoutMs },
    title,
    status,
  );
}

async function waitForNoRowWithTitle(page: Page, title: string, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (needle) => {
      const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
      return !rows.some((el) => (el.textContent ?? '').trim() === needle);
    },
    { timeout: timeoutMs },
    title,
  );
}

async function clickActionByTitle(page: Page, action: string, title: string): Promise<void> {
  // Click the button with [data-action="<action>"] inside the row whose title
  // matches. Walks the DOM the same way a user would.
  const clicked = await page.evaluate(
    (act, needle) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]'));
      for (const row of rows) {
        const t = row.querySelector('[data-task-title]')?.textContent?.trim();
        if (t !== needle) continue;
        const btn = row.querySelector<HTMLButtonElement>(`[data-action="${act}"]`);
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    },
    action,
    title,
  );
  if (!clicked) throw new Error(`no row matching ${JSON.stringify(title)} with action ${action}`);
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });
  await mkdir(TOKEN_HOME, { recursive: true });

  // Seed two SPA-style sessions before the api boots so each browser can
  // localStorage-prime its token and skip the WebAuthn ceremony.
  const browserA = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  const browserB = seedCliToken({ dbPath: DB_PATH, displayName: 'elisa', label: 'browser-seed' });
  // Token file for any CLI calls we might add later — harmless to leave.
  await writeFile(TOKEN_PATH, browserA.token, { encoding: 'utf8', mode: 0o600 });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    const tokens = [browserA.token, browserB.token];
    const labels = ['alex', 'elisa'];
    const pages: Page[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const browser = await puppeteer.launch({
        userDataDir: resolve(PROFILES, `auth-${i}`),
        args: ['--no-sandbox', '--ignore-certificate-errors'],
      });
      browsers.push(browser);
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      pages.push(page);
      await page.evaluateOnNewDocument((seedToken: string) => {
        try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
      }, tokens[i]!);
      await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      // The display name in the drawer proves the seeded session worked and the
      // WS handshake succeeded. `/` is the shell launcher — open the Tasks app
      // from it so the tasks panel mounts.
      await waitForSignedInAs(page, labels[i]!);
      await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
      await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    }

    const [pageA, pageB] = pages;
    if (!pageA || !pageB) throw new Error('expected two browser pages');

    // ─── 1. A creates → B receives via broadcast ────────────────────────────
    await pageA.locator('#tasks-quick-add').fill('Pick up parcel');
    await pageA.locator('[data-action="tasks:quick-add"]').click();
    await waitForRowWithTitle(pageA, 'Pick up parcel');
    await waitForRowWithTitle(pageB, 'Pick up parcel');
    console.log('e2e-tasks-multi: create propagated A → B');

    // ─── 2. B completes → A sees the status flip ────────────────────────────
    await clickActionByTitle(pageB, 'tasks:toggle', 'Pick up parcel');
    await waitForRowStatus(pageB, 'Pick up parcel', 'done');
    await waitForRowStatus(pageA, 'Pick up parcel', 'done');
    console.log('e2e-tasks-multi: complete propagated B → A');

    // ─── 3. A reopens → B sees it back to open ──────────────────────────────
    // The Today filter excludes done rows, so before reopening B's row is in
    // its inbox but visually checked. Reopening flips it back.
    await clickActionByTitle(pageA, 'tasks:toggle', 'Pick up parcel');
    await waitForRowStatus(pageA, 'Pick up parcel', 'open');
    await waitForRowStatus(pageB, 'Pick up parcel', 'open');
    console.log('e2e-tasks-multi: reopen propagated A → B');

    // ─── 4. A deletes → B sees it leave inbox; Trash on B shows it ──────────
    await clickActionByTitle(pageA, 'tasks:delete', 'Pick up parcel');
    await waitForNoRowWithTitle(pageA, 'Pick up parcel');
    await waitForNoRowWithTitle(pageB, 'Pick up parcel');

    // Both browsers switch to Trash.
    for (const page of [pageA, pageB]) {
      await page.locator('[data-action-view="trash"]').click();
    }
    // The deleted row reappears on both, with a Restore button.
    await waitForRowWithTitle(pageA, 'Pick up parcel');
    await waitForRowWithTitle(pageB, 'Pick up parcel');
    const restoreBtnA = await pageA.$('[data-action="tasks:restore"]');
    const restoreBtnB = await pageB.$('[data-action="tasks:restore"]');
    if (!restoreBtnA || !restoreBtnB) throw new Error('expected restore button on both devices');
    console.log('e2e-tasks-multi: delete propagated A → B, both Trash views consistent');

    await captureScreenshots(browsers, 'ok');
    console.log('e2e-tasks-multi: OK');
    return 0;
  } catch (err) {
    console.error('e2e-tasks-multi: FAIL', err);
    await captureScreenshots(browsers, 'fail');
    return 1;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
