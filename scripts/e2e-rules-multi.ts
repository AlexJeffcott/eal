#!/usr/bin/env bun
/**
 * Cross-device convergence test for agent-rules.
 *
 * Two real Chromium browsers, one household. The first creates a rule via the
 * panel; the second hits Refresh and sees it. Then the second deletes the
 * rule; the first hits Refresh and sees it gone.
 *
 * Unlike tasks-multi this is a "refresh convergence" test, not a "broadcast"
 * test — agent-rules has no WS push today. Asserting via Refresh keeps the
 * test honest about the documented user workflow and would catch a regression
 * in the HTTP read path or the panel's render of the list. If broadcasts are
 * added later, rewrite this script to wait without the explicit Refresh and
 * confirm the convergence is now push-driven.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/rules-multi');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'rules-multi.sqlite');
const TOKEN_HOME = resolve(ARTIFACTS, 'cli-home');
const TOKEN_PATH = resolve(TOKEN_HOME, 'token');
const FIXED_PORT = '4109';
const RULE_NAME = `e2e-rules-${Date.now()}`;

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

async function waitForRuleRow(page: Page, name: string, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (needle) => {
      const cells = Array.from(document.querySelectorAll('[data-agent-rules-panel] *'));
      return cells.some((el) => (el.textContent ?? '').trim() === needle);
    },
    { timeout: timeoutMs },
    name,
  );
}

async function waitForNoRuleRow(page: Page, name: string, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (needle) => {
      const cells = Array.from(document.querySelectorAll('[data-agent-rules-panel] *'));
      return !cells.some((el) => (el.textContent ?? '').trim() === needle);
    },
    { timeout: timeoutMs },
    name,
  );
}

/**
 * Seed a paired family-phone device row directly in sqlite so the agent-rules
 * "target device" selector has a non-empty list. The real pairing flow needs
 * a browser-side WebCrypto key and the WS handshake; this script's concern is
 * the rules surface, so it short-circuits to the storage layer.
 */
function seedHandsetDevice(opts: {
  dbPath: string;
  userId: number;
  label: string;
}): number {
  const db = new Database(opts.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const now = new Date().toISOString();
  const inserted = db
    .prepare<{ id: number }, [number, string, string]>(
      `INSERT INTO family_phone_devices (user_id, label, kind, paired_at)
       VALUES (?, ?, 'handset', ?)
       RETURNING id`,
    )
    .get(opts.userId, opts.label, now);
  db.close();
  if (!inserted) throw new Error('seedHandsetDevice: insert did not return a row');
  return inserted.id;
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });
  await mkdir(TOKEN_HOME, { recursive: true });
  // The api boots with a self-signed cert; HTTP calls from this script must
  // accept it (puppeteer is already launched with --ignore-certificate-errors).
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const browserA = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'rules-multi' });
  const browserB = seedCliToken({ dbPath: DB_PATH, displayName: 'elisa', label: 'rules-multi' });
  await writeFile(TOKEN_PATH, browserA.token, { encoding: 'utf8', mode: 0o600 });

  // Seed a target device so the kind=place_call rule can be created.
  const seededDeviceId = seedHandsetDevice({
    dbPath: DB_PATH,
    userId: browserB.userId,
    label: 'kid-handset',
  });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    const tokens = [browserA.token, browserB.token];
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
      await page.goto(`${api.url}/agent-rules`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await page.waitForSelector('[data-agent-rules-panel]', { timeout: NAV_TIMEOUT_MS });
    }

    const [pageA, pageB] = pages;
    if (!pageA || !pageB) throw new Error('expected two browser pages');

    // ─── 1. A creates a rule against the HTTP API ───────────────────────────
    // The panel's NewRuleCard form is exercised by the agent-rules unit and
    // Playwright tiers; this script's concern is cross-device convergence, so
    // it mints the rule via the wire and asserts on B's view.
    const nextFireAt = new Date(Date.now() + 60_000).toISOString();
    const createBody = {
      name: RULE_NAME,
      enabled: true,
      target_device_id: seededDeviceId,
      kind: 'place_call',
      body: 'Time for bed.',
      next_fire_at: nextFireAt,
      cooldown_sec: 0,
    };
    const createResp = await fetch(`${api.url}/api/agent/rules`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${browserA.token}`,
      },
      body: JSON.stringify(createBody),
    });
    if (!createResp.ok) {
      const text = await createResp.text();
      throw new Error(`POST /api/agent/rules: ${createResp.status} ${text}`);
    }
    const created: { rule: { id: number } } = await createResp.json();
    console.log(`e2e-rules-multi: A created rule #${created.rule.id} via HTTP`);

    // ─── 2. B refreshes via the panel → sees the rule ───────────────────────
    await pageB.locator('[data-action="agent-rules:refresh"]').click();
    await waitForRuleRow(pageB, RULE_NAME);
    console.log('e2e-rules-multi: B sees A\'s rule after Refresh');

    // ─── 3. A refreshes too → sees the rule it just created ─────────────────
    await pageA.locator('[data-action="agent-rules:refresh"]').click();
    await waitForRuleRow(pageA, RULE_NAME);

    // ─── 4. B deletes the rule via HTTP ─────────────────────────────────────
    const deleteResp = await fetch(`${api.url}/api/agent/rules/${created.rule.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${browserB.token}` },
    });
    if (!deleteResp.ok) {
      throw new Error(`DELETE /api/agent/rules/${created.rule.id}: ${deleteResp.status}`);
    }

    // ─── 5. A refreshes → rule is gone ──────────────────────────────────────
    await pageA.locator('[data-action="agent-rules:refresh"]').click();
    await waitForNoRuleRow(pageA, RULE_NAME);
    console.log('e2e-rules-multi: A sees the deletion after Refresh');

    await captureScreenshots(browsers, 'ok');
    console.log('e2e-rules-multi: OK');
    return 0;
  } catch (err) {
    console.error('e2e-rules-multi: FAIL', err);
    await captureScreenshots(browsers, 'fail');
    return 1;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
