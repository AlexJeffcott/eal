#!/usr/bin/env bun
/**
 * Verification artefact for the WS reconnect and resync — Plan 02,
 * `docs/plans/02-ws-reconnect-resync.md`.
 *
 * The defect: the browser WebSocket had no `close` handler. A phone that
 * suspends its tab loses the socket, the app keeps reading "connected", and
 * every broadcast sent while it was away is lost — the server keeps no
 * per-client event log. The list then stays wrong until a full page reload.
 *
 * This script reproduces that crossing, with two real browsers against a real
 * server, and proves the fix:
 *
 *   1. Both browsers sign in and open the Tasks app.
 *   2. Browser B goes offline AND its live socket is closed. B must SAY so —
 *      the reconnecting banner appears.
 *   3. While B is deaf, browser A creates a task. B cannot hear the
 *      broadcast; the row must be absent.
 *   4. B comes back online. The row must appear WITHOUT a reload, which only
 *      the re-seed on reconnect can do — the broadcast is long gone.
 *   5. The banner must clear, and the next broadcast must reach B live.
 *
 * Step 4 is the whole point. A test that reloads the page proves nothing: a
 * reload seeds from scratch and would pass against the broken code.
 *
 * Why both offline mode and an explicit close: Chrome's offline emulation
 * blocks new connections but leaves an established WebSocket open, so it alone
 * never reproduces the drop. The close makes the drop happen; offline mode
 * keeps the retries failing until the script says otherwise.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/tasks-reconnect');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'tasks-reconnect.sqlite');
const FIXED_PORT = '4112';
const TASK_TITLE = 'Bought while the phone was asleep';
/** Generous: the first backoff is 500ms, and `online` should pre-empt it. */
const RECONNECT_TIMEOUT_MS = 20_000;

/**
 * Record every WebSocket the page opens, so the harness can drop the live one.
 *
 * Instrumentation, not a product seam: the client keeps its socket in a
 * closure, and exposing it for a test would be a test-shaped hole in the
 * production API. A Proxy keeps `instanceof`, the static readyState constants
 * and the prototype intact, so the client cannot tell the difference.
 */
async function instrumentSockets(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const native = window.WebSocket;
    const opened: WebSocket[] = [];
    Reflect.set(window, '__ealSockets', opened);
    Reflect.set(
      window,
      'WebSocket',
      new Proxy(native, {
        construct(target, args: [string, (string | string[])?]) {
          const socket = new target(...args);
          opened.push(socket);
          return socket;
        },
      }),
    );
  });
}

/** Close the newest socket the page opened, as a lost network would. */
async function dropLiveSocket(page: Page): Promise<void> {
  const dropped = await page.evaluate(() => {
    const opened: unknown = Reflect.get(window, '__ealSockets');
    if (!Array.isArray(opened) || opened.length === 0) return false;
    const socket: unknown = opened[opened.length - 1];
    if (!(socket instanceof WebSocket)) return false;
    socket.close();
    return true;
  });
  if (!dropped) throw new Error('no live WebSocket to drop — instrumentation missed it');
}

async function rowExists(page: Page, title: string): Promise<boolean> {
  return page.evaluate((needle: string) => {
    const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
    return rows.some((el) => (el.textContent ?? '').trim() === needle);
  }, title);
}

async function waitForRowWithTitle(page: Page, title: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (needle: string) => {
      const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
      return rows.some((el) => (el.textContent ?? '').trim() === needle);
    },
    { timeout: timeoutMs },
    title,
  );
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });

  const userA = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  const userB = seedCliToken({ dbPath: DB_PATH, displayName: 'elisa', label: 'browser-seed' });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    const tokens = [userA.token, userB.token];
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
      await instrumentSockets(page);
      await page.evaluateOnNewDocument((seedToken: string) => {
        try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
      }, tokens[i]!);
      await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await waitForSignedInAs(page, labels[i]!);
      await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
      await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    }

    const [pageA, pageB] = pages;
    if (!pageA || !pageB) throw new Error('expected two browser pages');

    // ─── 1. Both live. Prove the ordinary broadcast path still works ────────
    await pageA.locator('#tasks-quick-add').fill('Before the nap');
    await pageA.locator('[data-action="tasks:quick-add"]').click();
    await waitForRowWithTitle(pageB, 'Before the nap', 10_000);
    console.log('e2e-tasks-reconnect: broadcast reaches B while the socket is up');

    // ─── 2. B loses the network. The socket closes; the app must say so ─────
    await pageB.setOfflineMode(true);
    await dropLiveSocket(pageB);
    await pageB.waitForSelector('[data-ws-reconnecting]', { timeout: RECONNECT_TIMEOUT_MS });
    console.log('e2e-tasks-reconnect: B reports "reconnecting" once its socket drops');

    // ─── 3. A creates while B is deaf ───────────────────────────────────────
    await pageA.locator('#tasks-quick-add').fill(TASK_TITLE);
    await pageA.locator('[data-action="tasks:quick-add"]').click();
    await waitForRowWithTitle(pageA, TASK_TITLE, 10_000);
    if (await rowExists(pageB, TASK_TITLE)) {
      throw new Error('B showed the task while offline — the harness is not really offline');
    }
    console.log('e2e-tasks-reconnect: the broadcast is missed, as expected');

    // ─── 4. B comes back. No reload anywhere in this script ─────────────────
    await pageB.setOfflineMode(false);
    await waitForRowWithTitle(pageB, TASK_TITLE, RECONNECT_TIMEOUT_MS);
    console.log('e2e-tasks-reconnect: B converged after reconnect, with no reload');

    // ─── 5. And the banner clears ───────────────────────────────────────────
    await pageB.waitForFunction(
      () => document.querySelector('[data-ws-reconnecting]') === null,
      { timeout: RECONNECT_TIMEOUT_MS },
    );

    // ─── 6. The live path works again afterwards ────────────────────────────
    // A reconnect that resyncs once but never re-subscribes would pass every
    // check above and still leave the socket deaf.
    await pageA.locator('#tasks-quick-add').fill('After waking');
    await pageA.locator('[data-action="tasks:quick-add"]').click();
    await waitForRowWithTitle(pageB, 'After waking', 10_000);
    console.log('e2e-tasks-reconnect: the topic subscription survived the reconnect');

    console.log('e2e-tasks-reconnect: OK');
    return 0;
  } catch (err) {
    console.error('e2e-tasks-reconnect: FAIL', err);
    for (let i = 0; i < browsers.length; i++) {
      const pages = await browsers[i]?.pages().catch(() => []) ?? [];
      for (let j = 0; j < pages.length; j++) {
        await pages[j]
          ?.screenshot({ path: resolve(ARTIFACTS, `device-${i}-page-${j}-fail.png`), fullPage: true })
          .catch(() => {});
      }
    }
    return 1;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
