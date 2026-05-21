#!/usr/bin/env bun
/**
 * Regression guard: eal's text-filter operator dropdown is usable at 350px.
 *
 * polly's <Dropdown> (the menu behind every <ActionSelect>) opens its menu
 * as a top-layer popover. polly < 0.73.1 shipped CSS that positioned the
 * menu against the viewport instead of the trigger, dropping it off-screen
 * in the bottom-left corner; polly 0.73.1 anchors the menu under its trigger
 * itself. This script proves the dropdown works, end to end, in eal's actual
 * app — so a future polly regression here is caught:
 *
 *   1. Sign in and open the tasks panel.
 *   2. Add a Text filter condition — that renders its operator <ActionSelect>.
 *   3. Click the operator dropdown and assert the menu sits directly below
 *      its trigger, fully inside the viewport.
 *   4. Pick an option and assert it commits — the dropdown is usable, not
 *      just visible.
 *
 * Runs at a 350px-wide viewport: the user's small phone is the hard floor.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/dropdown-position');
const PROFILE = resolve(ARTIFACTS, 'profile');
const DB_PATH = resolve(ARTIFACTS, 'dropdown-position.sqlite');
const FIXED_PORT = '4109';
const VIEWPORT = { width: 350, height: 640 };

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

const TRIGGER = '[data-condition-field="text"] [data-polly-dropdown] > button';
const MENU = '[data-condition-field="text"] [data-polly-dropdown] [popover]';

async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  });
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });

  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  let browser: Browser | undefined;

  try {
    browser = await puppeteer.launch({
      userDataDir: PROFILE,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    page.on('pageerror', (e: unknown) => {
      console.error('  [pageerror]', e instanceof Error ? e.message : String(e));
    });
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument((token: string) => {
      try {
        localStorage.setItem('eal-token', token);
      } catch {
        /* ignore */
      }
    }, seed.token);
    // Deep-link straight to the Tasks app. This doubles as the regression
    // guard for SPA deep-linking: `/tasks` must be server-served and mount the
    // app on a cold load, not 404.
    await page.goto(`${api.url}/tasks`, {
      waitUntil: 'networkidle0',
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });

    // ─── Add a Text filter — that renders the operator ActionSelect ─────────
    await page.locator('[data-action="tasks:add-condition"][data-action-field="text"]').click();
    await page.waitForSelector('[data-condition-field="text"]', { timeout: NAV_TIMEOUT_MS });

    // ─── Open the operator dropdown ─────────────────────────────────────────
    await page.locator(TRIGGER).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.matches(':popover-open') ?? false,
      { timeout: NAV_TIMEOUT_MS },
      MENU,
    );

    const trigger = await rectOf(page, TRIGGER);
    const menu = await rectOf(page, MENU);
    await page.screenshot({ path: resolve(ARTIFACTS, 'dropdown-open.png') });

    // The menu must sit just below the trigger — not dumped at the viewport
    // corner the way the unfixed polly CSS leaves it.
    const expectedTop = trigger.bottom + 4;
    if (Math.abs(menu.top - expectedTop) > 2) {
      throw new Error(
        `menu not anchored below trigger: menu.top=${menu.top}, expected≈${expectedTop} ` +
          `(trigger.bottom=${trigger.bottom})`,
      );
    }
    // And it must be fully inside the 350px viewport.
    if (menu.left < 0 || menu.right > VIEWPORT.width || menu.bottom > VIEWPORT.height) {
      throw new Error(
        `menu escapes the viewport: left=${menu.left}, right=${menu.right}, ` +
          `bottom=${menu.bottom}, viewport=${VIEWPORT.width}x${VIEWPORT.height}`,
      );
    }
    console.log('e2e-dropdown-position: menu anchored below trigger, inside viewport');

    // ─── Pick an option — the dropdown must actually be usable ──────────────
    await page.evaluate((menuSel) => {
      const options = document.querySelectorAll<HTMLElement>(`${menuSel} [role="option"]`);
      for (const opt of options) {
        if ((opt.textContent ?? '').trim() === 'exact') {
          opt.click();
          return;
        }
      }
      throw new Error('no "exact" option in the dropdown');
    }, MENU);

    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.textContent ?? '').trim() === 'exact',
      { timeout: NAV_TIMEOUT_MS },
      TRIGGER,
    );
    console.log('e2e-dropdown-position: option selected, trigger label updated');

    console.log('e2e-dropdown-position: OK');
    return 0;
  } catch (err) {
    console.error('e2e-dropdown-position: FAIL', err);
    if (browser) {
      const page = (await browser.pages())[0];
      if (page) {
        await page
          .screenshot({ path: resolve(ARTIFACTS, 'fail.png'), fullPage: true })
          .catch(() => {});
      }
    }
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
