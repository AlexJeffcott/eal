#!/usr/bin/env bun
/**
 * Verification artefact for the offline app shell — Plan 06 part A,
 * `docs/plans/06-offline-capture.md`.
 *
 * The defect: the service worker cached nothing, so a phone with no signal
 * opened a blank page. And behind that one, three more that only an offline
 * cold boot reaches: `GET /auth/me` was the only source of the user, so the app
 * opened signed out; the first WS connect never retried, so the app stayed deaf
 * when the network came back; and the first `connected` skipped the seed, so
 * the list stayed empty.
 *
 * One real browser against a real server, from a cold profile:
 *
 *   1. One online visit. That page is NOT controlled by the worker it
 *      registers, so nothing it fetched went through the fetch handler — the
 *      shell is cached only if the install precache works.
 *   2. The server dies. A reload must still render the shell, signed in, on a
 *      deep link, and must say it is reconnecting.
 *   3. The server returns. The task made in step 1 must appear WITHOUT a
 *      reload, and the banner must clear.
 *   4. The server restarts with `EAL_SW_KILL=1`. One visit must leave no
 *      registration and no cache.
 *   5. The server dies again. A reload must now FAIL — the proof that step 4
 *      removed the worker, and did not only report that it had.
 *
 * Why the outage is a killed process and not `page.setOfflineMode(true)`:
 * Chrome's offline emulation is per target, and a service worker is its own
 * target. The page would be offline while the worker's `fetch` still reached
 * the server, so network-first would answer from the network and the cache
 * fallback would never run.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitFor, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/offline-shell');
const PROFILE = resolve(ARTIFACTS, 'profile');
const DB_PATH = resolve(ARTIFACTS, 'offline-shell.sqlite');
const FIXED_PORT = '4118';
const TASK_TITLE = 'Written down before the tunnel';
/** The reconnect backoff caps at 30s, and no `online` event fires here. */
const RECONNECT_TIMEOUT_MS = 60_000;

function boot(env: Record<string, string> = {}): Promise<BootedApi> {
  return bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost', env });
}

async function workerState(page: Page): Promise<{ registrations: number; caches: string[] }> {
  return page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: await caches.keys(),
  }));
}

async function rowExists(page: Page, title: string): Promise<boolean> {
  return page.evaluate((needle: string) => {
    const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
    return rows.some((el) => (el.textContent ?? '').trim() === needle);
  }, title);
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });

  const user = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });

  let api: BootedApi | null = await boot();
  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      userDataDir: PROFILE,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.evaluateOnNewDocument((seedToken: string) => {
      try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
    }, user.token);

    // ─── 1. One online visit, from a cold profile ───────────────────────────
    await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForSignedInAs(page, 'alex');
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await page.locator('#tasks-quick-add').fill(TASK_TITLE);
    await page.locator('[data-action="tasks:quick-add"]').click();
    await waitFor(() => rowExists(page, TASK_TITLE), { description: 'the task row, online' });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await waitFor(async () => (await workerState(page)).caches.length === 1, {
      description: 'the shell cache after one visit',
    });
    console.log('e2e-offline-shell: one online visit leaves a worker and one cache');

    // ─── 2. The server dies. Reload on a deep link ──────────────────────────
    await api.kill();
    api = null;
    await page.goto(`https://localhost:${FIXED_PORT}/tasks`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    console.log('e2e-offline-shell: with no server, /tasks renders the app, signed in');
    await page.waitForSelector('[data-ws-reconnecting]', { timeout: NAV_TIMEOUT_MS });
    console.log('e2e-offline-shell: and it reports "reconnecting"');
    if (await rowExists(page, TASK_TITLE)) {
      throw new Error('the task row rendered with no server — something cached the list; step 3 proves nothing');
    }

    // ─── 3. The server returns. No reload anywhere in this step ─────────────
    api = await boot();
    await waitFor(() => rowExists(page, TASK_TITLE), {
      timeoutMs: RECONNECT_TIMEOUT_MS,
      description: 'the task row after the server returned, with no reload',
    });
    await page.waitForFunction(
      () => document.querySelector('[data-ws-reconnecting]') === null,
      { timeout: RECONNECT_TIMEOUT_MS },
    );
    console.log('e2e-offline-shell: the list seeded itself when the server returned');

    // ─── 4. The kill switch ─────────────────────────────────────────────────
    await api.kill();
    api = await boot({ EAL_SW_KILL: '1' });
    await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitFor(
      async () => {
        const state = await workerState(page);
        return state.registrations === 0 && state.caches.length === 0;
      },
      { timeoutMs: NAV_TIMEOUT_MS, description: 'no registration and no cache under EAL_SW_KILL=1' },
    );
    console.log('e2e-offline-shell: EAL_SW_KILL=1 leaves no registration and no cache');

    // ─── 5. And the worker is really gone ───────────────────────────────────
    await api.kill();
    api = null;
    const outcome = await page
      .goto(`https://localhost:${FIXED_PORT}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      .then(() => 'rendered', () => 'failed');
    if (outcome !== 'failed') {
      throw new Error('the page loaded with no server after the kill — a worker is still serving it');
    }
    console.log('e2e-offline-shell: after the kill, no server means no page');

    console.log('e2e-offline-shell: OK');
    return 0;
  } catch (err) {
    console.error('e2e-offline-shell: FAIL', err);
    const pages = (await browser?.pages().catch(() => [])) ?? [];
    for (let j = 0; j < pages.length; j++) {
      await pages[j]
        ?.screenshot({ path: resolve(ARTIFACTS, `page-${j}-fail.png`), fullPage: true })
        .catch(() => {});
    }
    return 1;
  } finally {
    await browser?.close().catch(() => {});
    await api?.kill();
  }
}

process.exit(await main());
