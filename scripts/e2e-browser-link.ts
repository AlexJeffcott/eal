#!/usr/bin/env bun
/**
 * Verification artefact for signing a browser in by pairing.
 *
 * The defect: a passkey was the only way in. An installed PWA window whose
 * password manager does not run there is offered nothing but the platform's
 * "use a phone" QR code, and the owner of the account cannot sign in on their
 * own laptop. The sign-in page now has "Link this browser": it shows a code, a
 * signed-in device claims the code on the pairing page, and the poll hands the
 * new browser a session — the device-code flow `eal auth pair` already used.
 *
 * Two real browsers against a real server:
 *
 *   1. Browser A is signed in. Browser B is cold: no token, no passkey, no
 *      virtual authenticator — so nothing but the link can let it in.
 *   2. B presses "Link this browser" and shows a code.
 *   3. A opens Menu → "Pair a device", types B's code and a label.
 *   4. B must sign in BY ITSELF — no reload, no click — as the same user.
 *   5. B's session is a real one: a task A creates reaches B over the WS, and
 *      the database holds exactly one new session row carrying A's label.
 *   6. B reloads and is still signed in: the token reached its storage.
 *   7. A code is single-use: claiming it a second time is refused.
 */
import { Database } from 'bun:sqlite';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitFor, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/browser-link');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'browser-link.sqlite');
const FIXED_PORT = '4122';
const LABEL = 'the laptop PWA';
const TASK_TITLE = 'Seen by the linked browser';
/** The poll interval is the server's; the link must land well inside this. */
const LINK_TIMEOUT_MS = 30_000;

function sessionLabels(): string[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .query<{ label: string | null }, []>('SELECT label FROM sessions ORDER BY created_at, rowid')
      .all()
      .map((row) => row.label ?? '');
  } finally {
    db.close();
  }
}

async function launch(name: string, browsers: Browser[]): Promise<Page> {
  const browser = await puppeteer.launch({
    userDataDir: resolve(PROFILES, name),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  browsers.push(browser);
  return (await browser.pages())[0] ?? (await browser.newPage());
}

async function rowExists(page: Page, title: string): Promise<boolean> {
  return page.evaluate((needle: string) => {
    const rows = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
    return rows.some((el) => (el.textContent ?? '').trim() === needle);
  }, title);
}

async function claim(page: Page, code: string): Promise<void> {
  await page.locator('#cli-pair-code').fill(code);
  await page.locator('#cli-pair-label').fill(LABEL);
  await page.locator('[data-action="cli-pair:claim"]').click();
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });

  const user = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    // ─── 1. A signed in, B cold ─────────────────────────────────────────────
    const pageA = await launch('signed-in', browsers);
    await pageA.evaluateOnNewDocument((seedToken: string) => {
      try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
    }, user.token);
    await pageA.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForSignedInAs(pageA, 'alex');

    const pageB = await launch('cold', browsers);
    // The owner's phone is the floor: the code must fit at 350px.
    await pageB.setViewport({ width: 350, height: 750 });
    await pageB.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await pageB.waitForSelector('[data-sign-in]', { timeout: NAV_TIMEOUT_MS });
    const before = sessionLabels();

    // ─── 2. B asks to be linked ─────────────────────────────────────────────
    await pageB.locator('[data-action="auth:link-start"]').click();
    await pageB.waitForSelector('[data-browser-link-code]', { timeout: NAV_TIMEOUT_MS });
    const code = await pageB.$eval('[data-browser-link-code]', (el) => (el.textContent ?? '').trim());
    if (code.length === 0) throw new Error('B showed an empty code');
    const overflow = await pageB.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) throw new Error(`the sign-in page overflows by ${overflow}px with the code shown`);
    console.log('e2e-browser-link: a cold browser shows a code, and it fits 350px');

    // ─── 3. A claims it, through the menu ───────────────────────────────────
    await pageA.locator('[data-action="shell:nav-toggle"]').click();
    await pageA.locator('[data-action-path="/public/auth/cli-pair"]').click();
    await pageA.waitForSelector('[data-cli-pair-form]', { timeout: NAV_TIMEOUT_MS });
    await claim(pageA, code);
    await pageA.waitForSelector('[data-cli-pair-success]', { timeout: NAV_TIMEOUT_MS });
    console.log('e2e-browser-link: the signed-in browser claims it from Menu → Pair a device');

    // ─── 4. B signs in by itself ────────────────────────────────────────────
    await pageB.waitForFunction(() => document.querySelector('[data-sign-in]') === null, {
      timeout: LINK_TIMEOUT_MS,
    });
    await waitForSignedInAs(pageB, 'alex');
    console.log('e2e-browser-link: the cold browser signed in with no reload and no click');

    // ─── 5. And the session is real ─────────────────────────────────────────
    const after = sessionLabels();
    const added = after.slice(before.length);
    if (added.length !== 1 || added[0] !== LABEL) {
      throw new Error(`expected one new session labelled "${LABEL}", got ${JSON.stringify(added)}`);
    }
    await pageB.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await pageB.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await pageA.goto(`${api.url}/tasks`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await pageA.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await pageA.locator('#tasks-quick-add').fill(TASK_TITLE);
    await pageA.locator('[data-action="tasks:quick-add"]').click();
    await waitFor(() => rowExists(pageB, TASK_TITLE), {
      timeoutMs: 10_000,
      description: 'a broadcast reaching the linked browser',
    });
    console.log('e2e-browser-link: one new session row, and the linked browser hears broadcasts');

    // ─── 6. It survives a reload ────────────────────────────────────────────
    await pageB.reload({ waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForSignedInAs(pageB, 'alex');
    console.log('e2e-browser-link: the linked browser is still signed in after a reload');

    // ─── 7. A code is single-use ────────────────────────────────────────────
    await pageA.goto(`${api.url}/public/auth/cli-pair`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await pageA.waitForSelector('[data-cli-pair-form]', { timeout: NAV_TIMEOUT_MS });
    await claim(pageA, code);
    await waitFor(
      () => pageA.evaluate(() => document.querySelector('[data-cli-pair-error]') !== null),
      { description: 'the second claim of the same code being refused' },
    );
    if (sessionLabels().length !== after.length) {
      throw new Error('a second claim of a used code minted another session');
    }
    console.log('e2e-browser-link: the same code claimed again is refused, and mints nothing');

    console.log('e2e-browser-link: OK');
    return 0;
  } catch (err) {
    console.error('e2e-browser-link: FAIL', err);
    for (let i = 0; i < browsers.length; i++) {
      const pages = (await browsers[i]?.pages().catch(() => [])) ?? [];
      for (let j = 0; j < pages.length; j++) {
        await pages[j]
          ?.screenshot({ path: resolve(ARTIFACTS, `browser-${i}-page-${j}-fail.png`), fullPage: true })
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
